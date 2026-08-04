import { AnimBlock } from './tracks';

/** One entry of the model's sequence table, off the parsed `Animation` struct. */
export interface Sequence {
  /** File slot -- what indexes every animation block's `tracks` array. */
  index: number;
  /** `AnimationData.dbc` id. Several sequences can share one id as variations. */
  id: number;
  /** Variation discriminator within an id. */
  subId: number;
  lengthMs: number;
  flags: number;
  /** Selection weight among variations sharing `id`. */
  probability: number;
  blendTimeMs: number;
  /** Authored design movement speed, yd/s. `0` for a non-locomotion sequence. */
  moveSpeed: number;
  nextAnimationId: number;
  alias: number;
  /** Derived from `flags` -- the clock law for every track this sequence drives. */
  loops: boolean;
}

/** The subset of parsed M2 data the animation layer reads. */
export interface M2AnimData {
  animations: any[];
  /** Global sequence durations, ms. */
  sequences: number[];
  bones: any[];
  uvAnimations?: any[];
  transparencyAnimations?: any[];
  vertexColorAnimations?: any[];
}

/**
 * Whether a sequence loops.
 *
 * benilla's rule, verified for 1.12.1 (`key_anim.rs:57`): sequence flags bit 0 CLEAR means the band
 * loops. Isolated in one function on purpose -- it is the one piece of benilla's semantics whose
 * 3.3.5 equivalence has not been confirmed against real data, and Task 20's probe corrects it here
 * if it differs.
 */
export function sequenceLoops(flags: number): boolean {
  return (flags & 0x01) === 0;
}

/** Does an animation block hold any keys at all? */
function blockAnimated(block: AnimBlock | undefined): boolean {
  if (!block || !block.tracks) {
    return false;
  }
  for (let i = 0, len = block.tracks.length; i < len; ++i) {
    if (block.tracks[i].timestamps.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Does this model animate anything at all?
 *
 * benilla measured that roughly nine in ten PLACED doodads animate no channel
 * (`doodad_anim.rs:17-19`). Those keep the existing static path and never allocate an instance,
 * which is the single largest performance win available here -- and it costs nothing at runtime,
 * because the work simply never starts.
 */
export function classify(data: M2AnimData): boolean {
  const bones = data.bones || [];
  for (let i = 0, len = bones.length; i < len; ++i) {
    const bone = bones[i];
    if (blockAnimated(bone.translation) || blockAnimated(bone.rotation) || blockAnimated(bone.scaling)) {
      return true;
    }
  }

  const uv = data.uvAnimations || [];
  for (let i = 0, len = uv.length; i < len; ++i) {
    if (blockAnimated(uv[i].translation) || blockAnimated(uv[i].rotation) || blockAnimated(uv[i].scaling)) {
      return true;
    }
  }

  const transparency = data.transparencyAnimations || [];
  for (let i = 0, len = transparency.length; i < len; ++i) {
    if (blockAnimated(transparency[i])) {
      return true;
    }
  }

  const colors = data.vertexColorAnimations || [];
  for (let i = 0, len = colors.length; i < len; ++i) {
    if (blockAnimated(colors[i].color) || blockAnimated(colors[i].alpha)) {
      return true;
    }
  }

  return false;
}

/** Sequence flag 0x40: this sequence is an alias for the one `alias` points at. */
const FLAG_ALIAS = 0x40;

/** Guard against a malformed alias ring. Real chains are one or two hops. */
const MAX_ALIAS_HOPS = 8;

/**
 * Per-model animation data: immutable, built ONCE per model path in the M2Blueprint cache.
 *
 * This is the whole fix for the bug that got the old system switched off. `THREE.AnimationMixer`
 * bound tracks by `bone.uuid + '.property'`, so every placement appended its own copy of every
 * track into the SHARED clips its instances took from the source M2 -- one clip accumulating tens
 * of thousands of tracks across a couple of hundred torches. Keyframes live here, once, and
 * placements hold nothing but a clock.
 */
export class ModelAnim {
  readonly sequences: Sequence[] = [];
  readonly globalSequenceDurations: number[];
  readonly animated: boolean;

  constructor(data: M2AnimData) {
    const animations = data.animations || [];
    for (let i = 0, len = animations.length; i < len; ++i) {
      const a = animations[i];
      this.sequences.push({
        index: i,
        id: a.id,
        subId: a.subID,
        lengthMs: a.length,
        flags: a.flags,
        probability: a.probability,
        blendTimeMs: a.blendTime,
        moveSpeed: a.movementSpeed,
        nextAnimationId: a.nextAnimationID,
        alias: a.alias,
        loops: sequenceLoops(a.flags),
      });
    }

    this.globalSequenceDurations = data.sequences || [];
    this.animated = classify(data);
  }

  /** Every sequence sharing an `AnimationData.dbc` id -- the variation set. */
  variationsOf(animId: number): Sequence[] {
    const out: Sequence[] = [];
    for (let i = 0, len = this.sequences.length; i < len; ++i) {
      if (this.sequences[i].id === animId) {
        out.push(this.sequences[i]);
      }
    }
    return out;
  }

  /**
   * Choose among an id's variations by frequency weight.
   *
   * Port of benilla's `pick_variation` (`anims.rs:189`). `roll` comes from the single shared RNG
   * stream -- see `variation-cycle.ts` for why the stream must be shared rather than seeded per
   * placement.
   *
   * An all-zero weight set still returns a variation: some models leave `probability` unset, and
   * refusing to pick would freeze them instead of animating them uniformly.
   */
  pickVariation(animId: number, roll: number): Sequence | null {
    const variations = this.variationsOf(animId);
    if (variations.length === 0) {
      return null;
    }

    let total = 0;
    for (let i = 0, len = variations.length; i < len; ++i) {
      total += variations[i].probability;
    }
    if (total <= 0) {
      return variations[roll % variations.length];
    }

    let cumulative = 0;
    for (let i = 0, len = variations.length; i < len; ++i) {
      cumulative += variations[i].probability;
      if (roll < cumulative) {
        return variations[i];
      }
    }

    return variations[variations.length - 1];
  }

  /**
   * Resolve a requested animation id to a sequence this model actually owns.
   *
   * Port of benilla's `resolve` (`anims.rs:213`). Three steps, in order: follow an alias chain to
   * its target; return a directly owned id; otherwise fall back to sequence 0 (Stand).
   *
   * Falling back rather than returning null for an unowned id is deliberate -- a unit asked to play
   * an animation its model lacks should stand, not freeze in bind pose.
   */
  resolve(requestedId: number): Sequence | null {
    if (this.sequences.length === 0) {
      return null;
    }

    let current = this.findById(requestedId);

    for (let hop = 0; current && (current.flags & FLAG_ALIAS) !== 0 && hop < MAX_ALIAS_HOPS; ++hop) {
      const target = this.sequences[current.alias];
      if (!target || target === current) {
        break;
      }
      current = target;
    }

    return current || this.sequences[0];
  }

  private findById(animId: number): Sequence | null {
    for (let i = 0, len = this.sequences.length; i < len; ++i) {
      if (this.sequences[i].id === animId) {
        return this.sequences[i];
      }
    }
    return null;
  }
}
