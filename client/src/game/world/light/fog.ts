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
 * One MFOG record as the ROOT loader hands it to `MapLight` -- `MfogRecord` plus the fields
 * `select_wmo_fog` needs to decide whether the record engages at all: its WMO-local position, its
 * inner/outer radius band, and its flags. `pos`/`radiusInner`/`radiusOuter`/`flags` are WMO local
 * space, matching MOLT (see `WMORootDefinition.createLights`).
 */
export type WmoFogRecord = MfogRecord & {
  pos: { x: number; y: number; z: number };
  radiusInner: number;
  radiusOuter: number;
  flags: number;
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

/**
 * The camera-in-interior MFOG record selection, ported from `samples/benilla`'s
 * `select_wmo_fog` (`crates/benilla/src/wmo_portal/fog.rs:52-90`).
 *
 * The law, read off that source rather than summarised: `fogs.len() < 2` bails to `null` --
 * one-record rooms keep the scene fog verbatim (the ref forge's "null fog" record shows the
 * storm's veil unmodified; a one-record engagement made those rooms too crisp). Otherwise seed
 * `acc` with record 0 (the WMO default fog), then walk `offsets`: an offset that does not index a
 * real record, or whose record has `flags & 1` set (infinite-radius records are never distance
 * candidates -- only the seed itself is), is dropped. A candidate's distance to its OWN `pos` must
 * be `<= radiusOuter`; further out, it does not engage at all. Candidates are sorted FARTHEST
 * first so the NEAREST is blended in LAST (closer wins ties). Each candidate blends over the
 * running accumulator by weight `1 - (d - radiusInner) / (radiusOuter - radiusInner)`, clamped to
 * `[0, 1]`, or `1` outright when the band has no width. The result is a single blended
 * `MfogRecord`-shaped triple, never a set of records -- `WmoFogRamp.blend` (the caller) crossfades
 * the SCENE fog toward this one target over four seconds either way.
 */
export function selectWmoFogTarget(
  fogs: WmoFogRecord[] | null | undefined,
  offsets: readonly number[] | null | undefined,
  eyeLocal: { x: number; y: number; z: number },
): MfogRecord | null {
  if (!fogs || fogs.length < 2) {
    return null;
  }

  const candidates: Array<{ distance: number; record: WmoFogRecord }> = [];

  if (offsets) {
    for (const offset of offsets) {
      const record = fogs[offset];

      if (!record) {
        continue;
      }

      // Bit 0: infinite-radius record. Those are never distance candidates -- only the seed
      // (record 0) is unconditional.
      if (record.flags & 1) {
        continue;
      }

      const distance = Math.hypot(
        eyeLocal.x - record.pos.x,
        eyeLocal.y - record.pos.y,
        eyeLocal.z - record.pos.z,
      );

      if (distance <= record.radiusOuter) {
        candidates.push({ distance, record });
      }
    }
  }

  // Farthest first, so the nearest candidate is blended in LAST and wins.
  candidates.sort((a, b) => b.distance - a.distance);

  let acc: MfogRecord = toMfogRecord(fogs[0]);

  for (const { distance, record } of candidates) {
    const span = record.radiusOuter - record.radiusInner;
    const weight = span > 0
      ? Math.min(1, Math.max(0, 1 - (distance - record.radiusInner) / span))
      : 1;

    const target = toMfogRecord(record);

    acc = {
      color: [
        acc.color[0] + (target.color[0] - acc.color[0]) * weight,
        acc.color[1] + (target.color[1] - acc.color[1]) * weight,
        acc.color[2] + (target.color[2] - acc.color[2]) * weight,
      ],
      end: acc.end + (target.end - acc.end) * weight,
      startScalar: acc.startScalar + (target.startScalar - acc.startScalar) * weight,
    };
  }

  return acc;
}

function toMfogRecord(record: WmoFogRecord): MfogRecord {
  return { color: record.color, end: record.end, startScalar: record.startScalar };
}

/** Crossfade rate: 0.25/second, i.e. four seconds in and four seconds out. */
export const WMO_FOG_RAMP_PER_SEC = 0.25;

// Below this span, `1/(end-start)` is treated as a divide-by-zero rather than merely a very steep
// slope. A zero-width (or coincident) band handing the shader an infinite/NaN `x` or `y` would blank
// whatever geometry reads it, silently, rather than just rendering a slightly-too-sharp fog edge.
const MIN_FOG_SPAN = 1e-4;

/**
 * Pack a (start, end) fog range the way the shader's `f1 = distance * x + y` expects: falling from
 * 1 at `start` to 0 at `end`, `z`/`w` fixed at 1 (see `blendLights`'s comment on this exact packing).
 *
 * The one definition both `blendLights` (the scene fog) and `MapLight` (the WMO interior fog) call --
 * two independent copies of a packing this subtle is how they drift, and reading this same packing
 * back out has already cost this project one fix round (see `SceneLight.fogEnd`/`fogStart`).
 *
 * Guards a zero-width (`start === end`) band: `1/(end-start)` would otherwise be `Infinity` (or `NaN`
 * once multiplied through), which is not a hypothetical -- an unset or coincident MFOG record hits
 * this every time. The span is floored to `MIN_FOG_SPAN`, sign-preserved, so the result stays finite
 * and the fog simply becomes an effectively instantaneous cutoff at `end` instead of poisoning the
 * uniform.
 */
export function packFogParams(start: number, end: number): [number, number, number, number] {
  const rawSpan = end - start;
  const span = Math.abs(rawSpan) < MIN_FOG_SPAN
    ? (rawSpan < 0 ? -MIN_FOG_SPAN : MIN_FOG_SPAN)
    : rawSpan;
  const step = 1.0 / span;
  return [-step, end * step, 1.0, 1.0];
}

/**
 * Invert `packFogParams`: recover `(start, end)` from the packed `(x, y)` pair. `end = -y/x`, then
 * `start = end + 1/x` -- see `SceneLight.fogEnd`/`fogStart` for why it is `+1/x` and not `-1/x`.
 */
export function unpackFogParams(x: number, y: number): { start: number; end: number } {
  if (x === 0) {
    return { start: 0, end: 0 };
  }
  const end = -y / x;
  const start = end + 1.0 / x;
  return { start, end };
}

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
