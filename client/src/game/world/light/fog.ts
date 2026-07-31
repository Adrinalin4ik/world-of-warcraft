/**
 * Fog laws, ported from `samples/benilla` (`lighting/resolve.rs`). Imports nothing, for the same reason
 * `laws.ts` does not: node-testable without three.js.
 */

export type FogTriple = {
  color: [number, number, number];
  start: number;
  end: number;
};

/** One MFOG record as the staging law consumes it. `startScalar` is a FRACTION of `end`. */
export type MfogRecord = {
  color: [number, number, number];
  end: number;
  startScalar: number;
};

/**
 * Stage an MFOG record into a usable triple: `end = min(record end, farclip)`, and
 * `start = end * startScalar` off the CLAMPED end.
 *
 * The start really is a fraction rather than a distance in 1.12.1 -- reading it as absolute yards puts
 * the near plane of the fog in the wrong place entirely.
 */
export function stageMfog(record: MfogRecord, farclip: number): FogTriple {
  const end = Math.min(record.end, farclip);
  return { color: record.color, start: end * record.startScalar, end };
}

/** Crossfade rate: 0.25/second, i.e. four seconds in and four seconds out. */
export const WMO_FOG_RAMP_PER_SEC = 0.25;

/**
 * The camera-in-WMO interior fog crossfade.
 *
 * While the camera stands in a WMO interior the scene fog -- a storm's veil included -- crossfades
 * toward the building's own MFOG fog over four seconds, and back out over four on leaving. That is why
 * a reference inn keeps its warm authored haze while a storm rages outside: the storm's fog never
 * reaches the room.
 *
 * The staged triple LATCHES while the camera leaves, so the fade-out lerps FROM the room's fog rather
 * than popping to the scene fog and then fading nothing.
 */
export class WmoFogRamp {
  private t = 0;
  private staged: MfogRecord | null = null;

  /**
   * The raw MFOG record is latched, not a pre-staged triple, and `stageMfog` is re-run against
   * `farclip` on EVERY call -- including during fade-out, while `target` is null and we're only
   * consulting the latch. That is deliberate, not redundant: if it staged once on entry and cached
   * the result, a farclip change (e.g. the view-distance slider) while still inside the room would
   * silently stop re-clamping the interior fog. Re-staging every call means a farclip change is
   * picked up immediately, with no discipline required of the caller.
   */
  blend(target: MfogRecord | null, scene: FogTriple, farclip: number, dt: number): FogTriple {
    if (target) {
      this.staged = target;
    }

    const direction = target ? 1 : -1;
    this.t = Math.min(1, Math.max(0, this.t + direction * WMO_FOG_RAMP_PER_SEC * dt));

    if (!this.staged) {
      return scene;
    }

    if (this.t <= 0) {
      this.staged = null;
      return scene;
    }

    const k = this.t;
    const staged = stageMfog(this.staged, farclip);
    return {
      color: [
        scene.color[0] + (staged.color[0] - scene.color[0]) * k,
        scene.color[1] + (staged.color[1] - scene.color[1]) * k,
        scene.color[2] + (staged.color[2] - scene.color[2]) * k,
      ],
      start: scene.start + (staged.start - scene.start) * k,
      end: scene.end + (staged.end - scene.end) * k,
    };
  }

  /** The ramp's current blend weight, for the debug readout. */
  get weight(): number {
    return this.t;
  }
}
