import type Unit from '../classes/unit';

/**
 * A UNIT FADES IN WHEN IT ARRIVES AND OUT WHEN IT STREAMS AWAY -- the owner's "чтобы плавно исчезали
 * предметы и мобы", both directions.
 *
 * ## THE TWO CASES HAVE DIFFERENT STANDING, and the reference is careful about which
 *
 * **Appearing is byte-verified.** `FadeTo(1.0, 2000 ms)` -- "byte `0x7d0`, wall-clock via
 * `OsGetAsyncTimeMs`, framerate-independent" (`benilla-world/src/model_fade.rs:148-150`) -- with the
 * reference's own cubic ease, `alpha = lerp(from, to, clamp(t, 0, 1)^3)`, byte-located at `0x614a90`
 * (`:164`). Both are taken as they stand.
 *
 * **Disappearing is NOT, and the reference says so about itself**: "our stream-out look, not a verified
 * mechanism -- the wow-re teardown RE found no fade-out in the binary" (`:736-739`). It ships it anyway
 * on the director's eyes -- "on the reference, distant mobs fade out, never blink out" -- and that is the
 * ground this stands on too, not fidelity.
 *
 * **AND `SMSG_DESTROY_OBJECT` STILL POPS INSTANTLY.** That is the byte-verified half and it is
 * deliberately untouched here: "a *destroyed* object pops instantly, and the net bridge despawns it
 * directly, bypassing this" (`:738-739`). A corpse decaying, an object looted and despawned, an item
 * destroyed -- those are destroys, and they still go straight out. Only the OUT-OF-RANGE stream-out
 * fades, which is the case the owner is describing when a mob "disappears" as he walks away.
 *
 * ## THE ALPHA PATH ALREADY EXISTED, AND IT IS THE SAFE ONE
 *
 * I expected to have to build this and to have to argue about the shared-material trap first: alpha
 * lives in material uniforms, an instanceable M2 shares its batches with every other copy in the zone,
 * and writing one would fade all of them -- the failure `CLAUDE.md` records three rounds of.
 *
 * None of that applies, because the machinery is already here and already per-instance:
 * `pipeline/m2/submesh.js#applyFadeAlphaBeforeRender` pushes `fadeAlpha` into the shared uniform **on
 * every draw**, walking up "batch mesh -> Submesh -> M2" and stopping at whatever carries the property.
 * So the value lives on the INSTANCE and the shared uniform is only ever borrowed for the duration of
 * one draw call -- the save-and-restore shape `CLAUDE.md` names as the correct way to touch a shared
 * material. This file writes `model.fadeAlpha` and nothing else.
 *
 * The fragment side is `result.a *= fadeAlpha` (`material/fragment/common-header.glsl:292`), and for a
 * CUTOUT material the alpha test `sampled0.a * fadeAlpha < 0.5` turns a dropping fade into per-pixel
 * edge-first erosion -- which is exactly the dissolve the reference describes for that pass. **A fully
 * opaque batch will not blend and will pop at the end of its ramp**; the reference has the same split
 * (its trees are hard-edged) and that is stated here rather than discovered later.
 *
 * ## COST
 *
 * One `Set` lookup per entity per frame to notice an arrival -- the same walk `quest-markers.ts` and
 * `game-object-sparkle.ts` already make over the same collection -- plus one cubic per LIVE fade, of
 * which there are as many as things that appeared in the last two seconds. Nothing allocates on the
 * steady path. Zero UI draw-fingerprint by construction: these are world models, and
 * `drawListSignature` mixes interface draw items only.
 */

/**
 * `FadeTo(1.0, 2000 ms)` -- the reference's byte-verified appear duration (`model_fade.rs:148-150`).
 * The despawn ramp reuses it, as the reference's does.
 */
const FADE_MS = 2000;

/**
 * The reference's cubic-ease render alpha, `lerp(from, to, clamp(t, 0, 1)^3)` (`model_fade.rs:164`,
 * byte-located at `0x614a90`).
 *
 * The cube is the whole character of it: an appear spends most of its two seconds nearly invisible and
 * then arrives quickly, which is why a linear ramp reads as a ghost walking in and this does not.
 */
export function fadeCurve(from: number, to: number, t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const eased = clamped * clamped * clamped;
  return from + (to - from) * eased;
}

/** A model with the per-instance fade property `submesh.js` walks up to find. */
type Fadeable = { fadeAlpha?: number };

interface LiveFade {
  unit: Unit;
  from: number;
  to: number;
  elapsed: number;
  /** Remove the unit from the world when the ramp finishes -- the stream-out case. */
  removeOnDone: boolean;
}

export class ModelFade {
  /** Guids whose arrival has already been faded in, so an ordinary frame arms nothing. */
  private appeared = new Set<string>();

  private live: LiveFade[] = [];

  /** `window.worldModelFade()` reads this. */
  public stats = { appearing: 0, leaving: 0, appeared: 0, faded: 0, popped: 0 };

  constructor(private remove: (unit: Unit) => void) {}

  /**
   * Notice arrivals and advance every live ramp.
   *
   * Arrivals are detected by polling rather than hooked into `Unit`'s model setter, for the reason
   * `quest-markers.ts` gives about the same choice: the model lands several awaits deep in a path that
   * has enough to get right already, and a poll over a handful of entities cannot miss an ordering.
   */
  update(entities: Map<string, Unit>, deltaMs: number): void {
    for (const [guid, unit] of entities) {
      if (this.appeared.has(guid)) {
        continue;
      }
      const model = unit.model as unknown as Fadeable | null;
      if (!model) {
        // No body yet. Not marked, so the next frame looks again.
        continue;
      }
      this.appeared.add(guid);
      model.fadeAlpha = 0;
      this.live.push({ unit, from: 0, to: 1, elapsed: 0, removeOnDone: false });
      this.stats.appeared += 1;
    }

    // Forget guids that left, so a unit that streams back in fades in again -- which is the behaviour
    // the reference's per-entity component gives for free and a long-lived Set would quietly lose.
    if (this.appeared.size > entities.size) {
      for (const guid of Array.from(this.appeared)) {
        if (!entities.has(guid)) {
          this.appeared.delete(guid);
        }
      }
    }

    if (this.live.length === 0) {
      this.stats.appearing = 0;
      this.stats.leaving = 0;
      return;
    }
    let appearing = 0;
    let leaving = 0;
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const fade = this.live[i];
      fade.elapsed += deltaMs;
      const model = fade.unit.model as unknown as Fadeable | null;
      if (!model) {
        // The body went away mid-ramp -- a re-model, or a despawn. Nothing to drive.
        this.live.splice(i, 1);
        continue;
      }
      if (fade.elapsed >= FADE_MS) {
        model.fadeAlpha = fade.to;
        this.live.splice(i, 1);
        if (fade.removeOnDone) {
          this.remove(fade.unit);
          this.stats.faded += 1;
        }
        continue;
      }
      model.fadeAlpha = fadeCurve(fade.from, fade.to, fade.elapsed / FADE_MS);
      if (fade.to === 0) {
        leaving += 1;
      } else {
        appearing += 1;
      }
    }
    this.stats.appearing = appearing;
    this.stats.leaving = leaving;
  }

  /**
   * The unit streamed out of range: ramp it away, then remove it.
   *
   * A unit with no body has nothing to fade and is removed at once -- the reference's own arm for this
   * ("an entity with no fadeable geometry pops straight out"). Counted as `popped` so an unexpectedly
   * high number is visible rather than read as a broken fade.
   *
   * Re-entrant safe: a second call for a unit already leaving is ignored rather than restarting the
   * ramp, which would hold a departed unit in the scene indefinitely under a repeating out-of-range
   * block.
   */
  fadeOutAndRemove(unit: Unit): void {
    const model = unit.model as unknown as Fadeable | null;
    if (!model) {
      this.remove(unit);
      this.stats.popped += 1;
      return;
    }
    for (const fade of this.live) {
      if (fade.unit === unit && fade.removeOnDone) {
        return;
      }
    }
    // FROM THE CURRENT ALPHA, not from 1: a unit that streams out while still fading IN must ramp down
    // from where it actually is, or it would brighten first. The reference's `{from: alpha, to: 0}`.
    const from = typeof model.fadeAlpha === 'number' ? model.fadeAlpha : 1;
    this.live = this.live.filter((fade) => fade.unit !== unit);
    this.live.push({ unit, from, to: 0, elapsed: 0, removeOnDone: true });
  }
}

export default ModelFade;
