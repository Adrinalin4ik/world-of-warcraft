import * as THREE from 'three';

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
 * ## TWO MECHANISMS, AND WHICH ONE A MODEL GETS IS AN OWNERSHIP QUESTION
 *
 * The per-instance plumbing already existed and is already safe:
 * `pipeline/m2/submesh.js#applyFadeAlphaBeforeRender` pushes `fadeAlpha` -- and now `fadeBlend` -- into
 * the shared uniform **on every draw**, walking up "batch mesh -> Submesh -> M2" to whatever instance
 * carries the property. So the VALUE never lives on a shared material; it is borrowed for one draw call.
 *
 * The mechanism is not one thing, and the owner's report is why. A dissolve alone read as "слишком
 * резко" on a mob, because a screen-space dither is granular per pixel and a distant body covers few of
 * them. So:
 *
 *  - **A model that OWNS its batches gets real alpha blending** -- `borrowBlending` puts its own
 *    materials into `SrcAlpha/OneMinusSrcAlpha` with the alpha channel protected, and restores exactly
 *    what it took when the ramp ends. That is a genuine soft fade, and `ownsBatches` is what makes it
 *    safe: a character or a skinned creature rebuilt its own materials, so nothing else is drawing them.
 *  - **Anything else dissolves.** An instanceable doodad SHARES its materials with every copy of that
 *    path in the zone, so re-blending them would re-blend all of them -- the trap `CLAUDE.md` records
 *    three rounds of, and `ownsBatches` is the test it names.
 *
 * The `depthWrite = false` in the blend path is not incidental: a fading body that still writes depth
 * occludes its own far side and reads as a solid shell with holes in it.
 *
 * ## COST
 *
 * One `Set` lookup per entity per frame to notice an arrival -- the same walk `quest-markers.ts` and
 * `game-object-sparkle.ts` already make over the same collection -- plus one cubic per LIVE fade, of
 * which there are as many as things that appeared in the last half second. Nothing allocates on the
 * steady path. Zero UI draw-fingerprint by construction: these are world models, and
 * `drawListSignature` mixes interface draw items only.
 */

/**
 * `FadeTo(1.0, 2000 ms)` -- the reference's appear duration, byte-verified: "byte `0x7d0`, wall-clock via
 * `OsGetAsyncTimeMs`, framerate-independent" (`model_fade.rs:148-150`). The despawn ramp reuses it, as
 * the reference's does.
 *
 * **This was 500 for one round, at the owner's request, and he then said "давай как у референса тогда".**
 * So the verified number is back. Worth recording rather than quietly reverting: the 500 was his call on
 * how it read in play, and he withdrew it once told the 2000 was byte-verified -- which is the same
 * judgement this project applies everywhere else, that a measured value beats a preference unless the
 * measurement is shown to be about something else.
 */
const FADE_MS = 2000;

/**
 * The blend state a fade installs on a material it is allowed to touch, and the state it saves first.
 *
 * `SrcAlpha / OneMinusSrcAlpha` on the COLOUR channels, so weighting the output alpha blends the body
 * against the world -- and `Zero / One` on the ALPHA channels, so the framebuffer's alpha stays at the
 * cleared 1.0. That second pair is not optional: `material/index.ts` records that a sub-1 alpha left in
 * the buffer gets `(1 - a)` of the white page added by the compositor, which was the owner's white
 * doodads. The same protection modes >= 1 already carry.
 */
interface SavedBlend {
  material: THREE.Material;
  transparent: boolean;
  blending: THREE.Blending;
  blendSrc: THREE.BlendingSrcFactor;
  blendDst: THREE.BlendingDstFactor;
  blendSrcAlpha: THREE.Material['blendSrcAlpha'];
  blendDstAlpha: THREE.Material['blendDstAlpha'];
  depthWrite: boolean;
}

/**
 * The reference's cubic-ease render alpha, `lerp(from, to, clamp(t, 0, 1)^3)` (`model_fade.rs:164`,
 * byte-located at `0x614a90`).
 *
 * The cube is the whole character of it: an appear spends most of its ramp nearly invisible and
 * then arrives quickly, which is why a linear ramp reads as a ghost walking in and this does not.
 */
export function fadeCurve(from: number, to: number, t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const eased = clamped * clamped * clamped;
  return from + (to - from) * eased;
}

/**
 * A model with the per-instance fade properties `submesh.js` walks up to find, plus the ownership test
 * that decides which mechanism it gets.
 *
 * `ownsBatches` is the whole safety of the blend path: false means this M2 SHARES its materials with
 * every other copy of that path in the zone, so re-blending them would re-blend all of them. `CLAUDE.md`
 * names `ownsBatches` as exactly this test.
 */
type Fadeable = {
  fadeAlpha?: number;
  fadeBlend?: number;
  ownsBatches?: boolean;
  batches?: Map<number, unknown>;
};

/** Every material under a model's batches, or an empty list when there is nothing to walk. */
function materialsOf(model: Fadeable): THREE.Material[] {
  const out: THREE.Material[] = [];
  const batches = model.batches;
  if (!batches || typeof batches.forEach !== 'function') {
    return out;
  }
  batches.forEach((batch) => {
    const material = (batch as { material?: THREE.Material } | null)?.material;
    if (material) {
      out.push(material);
    }
  });
  return out;
}

/**
 * Put a model's OWN materials into real alpha blending for the duration of a fade, and hand back what
 * to restore.
 *
 * Returns an empty list -- meaning "use the dissolve instead" -- for a model that does not own its
 * batches. That is the guard, not an optimisation.
 */
function borrowBlending(model: Fadeable): SavedBlend[] {
  if (model.ownsBatches !== true) {
    return [];
  }
  const saved: SavedBlend[] = [];
  for (const material of materialsOf(model)) {
    const m = material as THREE.Material & {
      blendSrc: THREE.BlendingSrcFactor; blendDst: THREE.BlendingDstFactor;
      blendSrcAlpha: THREE.Material['blendSrcAlpha'];
      blendDstAlpha: THREE.Material['blendDstAlpha'];
    };
    saved.push({
      material: m,
      transparent: m.transparent,
      blending: m.blending,
      blendSrc: m.blendSrc,
      blendDst: m.blendDst,
      blendSrcAlpha: m.blendSrcAlpha,
      blendDstAlpha: m.blendDstAlpha,
      depthWrite: m.depthWrite,
    });
    m.transparent = true;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.SrcAlphaFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    // THE ALPHA CHANNEL IS PROTECTED. See `SavedBlend`: a sub-1 alpha left in the framebuffer gets the
    // white page composited into it, which was the owner's white doodads.
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;
    // A fading body must not occlude its own far side through the depth buffer, which is what makes a
    // half-faded model read as a solid shell with holes.
    m.depthWrite = false;
    m.needsUpdate = true;
  }
  return saved;
}

/** Put back exactly what `borrowBlending` took. */
function restoreBlending(saved: SavedBlend[]): void {
  for (const entry of saved) {
    const m = entry.material as THREE.Material & {
      blendSrc: THREE.BlendingSrcFactor; blendDst: THREE.BlendingDstFactor;
      blendSrcAlpha: THREE.Material['blendSrcAlpha'];
      blendDstAlpha: THREE.Material['blendDstAlpha'];
    };
    m.transparent = entry.transparent;
    m.blending = entry.blending;
    m.blendSrc = entry.blendSrc;
    m.blendDst = entry.blendDst;
    m.blendSrcAlpha = entry.blendSrcAlpha;
    m.blendDstAlpha = entry.blendDstAlpha;
    m.depthWrite = entry.depthWrite;
    m.needsUpdate = true;
  }
}

interface LiveFade {
  unit: Unit;
  from: number;
  to: number;
  elapsed: number;
  /** Remove the unit from the world when the ramp finishes -- the stream-out case. */
  removeOnDone: boolean;
  /** The blend state to put back when the ramp ends. Empty when this fade dissolves instead. */
  borrowed: SavedBlend[];
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
      const borrowed = borrowBlending(model);
      model.fadeBlend = borrowed.length > 0 ? 1 : 0;
      this.live.push({ unit, from: 0, to: 1, elapsed: 0, removeOnDone: false, borrowed });
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
        // The body went away mid-ramp -- a re-model, or a despawn. Nothing to drive, and nothing of the
        // model's own state left to put back.
        this.live.splice(i, 1);
        continue;
      }
      if (fade.elapsed >= FADE_MS) {
        model.fadeAlpha = fade.to;
        model.fadeBlend = 0;
        restoreBlending(fade.borrowed);
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
    // Restore anything an in-flight appear borrowed before taking it again, so the saved state is the
    // model's own and never a fade's.
    for (const fade of this.live) {
      if (fade.unit === unit) {
        restoreBlending(fade.borrowed);
      }
    }
    this.live = this.live.filter((fade) => fade.unit !== unit);
    const borrowed = borrowBlending(model);
    model.fadeBlend = borrowed.length > 0 ? 1 : 0;
    this.live.push({ unit, from, to: 0, elapsed: 0, removeOnDone: true, borrowed });
  }
}

export default ModelFade;
