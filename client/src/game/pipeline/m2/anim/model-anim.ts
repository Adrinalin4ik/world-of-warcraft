import { mergeExternalAnim, MergeableBlock, MERGE_REJECTED } from './external-anim-data';
import { AnimBlock, cursorMs, WRAP } from './tracks';
import { upperBodyMask } from './upper-body';

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
  /**
   * Derived from `flags` -- do this sequence's keyframes live in the `.m2` we parsed?
   *
   * `false` means QUARANTINED: the slot holds parsed noise, not keys. See `hasInlineData`.
   */
  inline: boolean;
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

/**
 * Sequence flag bits meaning "this sequence's keyframes are inline in the `.m2`".
 *
 * The same mask the old `AnimationManager` used to SKIP such sequences, and the one WoWModelViewer
 * and WebWoWViewer both test. Measured against real 3.3.5a data: wolf Stand/Walk/Run carry `0x20`
 * (also seen: `0x21`, `0x23`, `0x61`); the external ids 96-101 carry `0`, `1`, `3`, `5` and `8`.
 * Bit `0x40` (alias) is deliberately NOT in the mask -- see `hasInlineData` and `resolve`.
 */
const INLINE_MASK = 0x130;

/**
 * Whether a sequence's keyframes live in the `.m2` rather than a sibling `.anim` file.
 *
 * This is a SAFETY gate, not an optimisation. An external sequence's animation-block offsets point
 * into the `.anim` file, but the parser reads them against the `.m2` buffer -- so the arrays are not
 * empty, they are NOISE. Measured: 302 bone-tracks on `wolf.m2` and 130 on `kobold.m2` carry
 * timestamps far past their own sequence length, one of them 3,197,923,783 ms against a 2000 ms
 * sequence.
 *
 * Arming such a sequence samples that noise and wrecks the pose, and it is reachable in normal play
 * because `unit.ts` arms whatever id the server sends. Everything downstream of `ModelAnim` therefore
 * treats an external sequence as absent until Task 20 merges its real data and flips `inline` true
 * per sequence. The entries STAY in the table -- Task 20 lifts the quarantine, it does not add rows.
 */
export function hasInlineData(flags: number): boolean {
  return (flags & INLINE_MASK) !== 0;
}

/**
 * Which sequence slots a keyframe may legitimately be read from.
 *
 * Indexed by file slot, i.e. by position in an animation block's `tracks` array -- which is exactly
 * what `trackFor` and `channelTrackIndex` index with. A slot past the end reads `undefined`, which
 * is falsy, so a track with no owning sequence is quarantined too: nothing can ever arm it.
 */
function inlineSlots(data: M2AnimData): boolean[] {
  const animations = data.animations || [];
  const slots: boolean[] = new Array(animations.length);
  for (let i = 0, len = animations.length; i < len; ++i) {
    slots[i] = hasInlineData(animations[i].flags);
  }
  return slots;
}

/**
 * Is this block's track at `slot` readable, or is it quarantined noise?
 *
 * A GLOBAL-SEQUENCE block does not have a sequence timeline at all: it carries a single track, read
 * at index 0 whatever is playing. So a sequence slot's inline flag says nothing about it, and
 * quarantining one would silently freeze every clock-driven glow and sky band in the game. It is
 * exempt -- but at index 0 ONLY, matching what the sampler actually reads. A global block whose
 * track 0 is empty and whose track 1 is populated can never produce a sample, so calling it
 * animated would put the model in the posing set for nothing.
 *
 * The `channelTrackIndex` rule this mirrors is the MATERIAL path
 * (`material-channels.ts#channelTrackIndex`). `InstanceAnim#solveBone` samples bone blocks with a
 * raw `trackFor(def.translation, seqIndex)` and ignores `globalSequenceID` entirely, so for a
 * global-sequence BONE block the exemption admits a key the bone sampler will index by `seqIndex`
 * and usually miss. That inconsistency predates this quarantine and is left alone deliberately:
 * classifying such a model animated is the conservative side of a bug that lives elsewhere.
 */
function slotReadable(block: AnimBlock, slot: number, slots: boolean[]): boolean {
  return block.globalSequenceID > -1 ? slot === 0 : slots[slot] === true;
}

/** Does an animation block hold any keys at all, in a slot that is not quarantined? */
function blockAnimated(block: AnimBlock | undefined, slots: boolean[]): boolean {
  if (!block || !block.tracks) {
    return false;
  }
  for (let i = 0, len = block.tracks.length; i < len; ++i) {
    if (slotReadable(block, i, slots) && block.tracks[i].timestamps.length > 0) {
      return true;
    }
  }
  return false;
}

/** Total readable keys across a block's sequence tracks. Mirrors the parser's `keyframeCount`. */
function keyframeCount(block: AnimBlock, slots: boolean[]): number {
  let count = 0;
  for (let i = 0, len = block.tracks.length; i < len; ++i) {
    if (slotReadable(block, i, slots)) {
      count += block.tracks[i].timestamps.length;
    }
  }
  return count;
}

/** The block's first readable value in file order. Mirrors the parser's `firstKeyframe.value`. */
function firstValue(block: AnimBlock, slots: boolean[]): unknown {
  for (let i = 0, len = block.tracks.length; i < len; ++i) {
    const track = block.tracks[i];
    if (slotReadable(block, i, slots) && track.timestamps.length > 0) {
      return track.values[0];
    }
  }
  return undefined;
}

/**
 * Does a block hold keys that actually CHANGE anything?
 *
 * A block carrying exactly one key whose value is the channel's identity (fully opaque, white) is
 * not animation -- it is the default, written out as a keyframe. The uniform already holds that
 * value, so sampling it every frame produces a guaranteed no-op.
 *
 * This mirrors the parser's own rule for transparency
 * (`wow-data-parser/m2/index.js:196-204`: `keyframeCount > 1 || firstKeyframe.value !== 1.0`),
 * which the first cut of `classify()` dropped. It is not a micro-optimisation: measured against the
 * fixture set, `world_generic_passivedoodads_particleemitters_bubblesb.m2` and
 * `..._lavasplashparticle.m2` -- both `canInstance`, i.e. the mass-placed kind -- flip static ->
 * animated on a single transparency key of exactly 1.0. Every such placement would allocate an
 * `InstanceAnim`, join `animatedDoodads`, take a forced whole-subtree `updateMatrixWorld(true)` per
 * frame and get posed, for nothing. The ~90%-static rejection this whole design rests on erodes one
 * model at a time.
 *
 * An UNDECODABLE first value (missing `values` entry) counts as animated, matching the parser: a
 * `!== 1.0` comparison against `undefined` is true there too, and guessing "static" on malformed
 * data would freeze a channel rather than merely cost a sample.
 */
function blockAnimatedBeyondIdentity(
  block: AnimBlock | undefined,
  isIdentity: (value: unknown) => boolean,
  slots: boolean[],
): boolean {
  if (!blockAnimated(block, slots)) {
    return false;
  }
  if (keyframeCount(block!, slots) > 1) {
    return true;
  }
  return !isIdentity(firstValue(block!, slots));
}

/** Transparency and vertex-colour alpha are `color16` scalars; identity is fully opaque. */
function isOpaque(value: unknown): boolean {
  return value === 1.0;
}

/**
 * Vertex-colour RGB identity is white.
 *
 * The parser does NOT apply its single-key rule to vertex colour, only to transparency. Extending
 * it here is deliberate and safe by the same argument: `animatedVertexColorRGB` already defaults to
 * (1, 1, 1), so a lone white key changes nothing a sampler could produce. A lone NON-white key is
 * still counted -- that one does change the draw, even though it never varies.
 */
function isWhite(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 3 &&
    value[0] === 1.0 && value[1] === 1.0 && value[2] === 1.0;
}

/**
 * Does this model animate anything at all?
 *
 * benilla measured that roughly nine in ten PLACED doodads animate no channel
 * (`doodad_anim.rs:17-19`). Those keep the existing static path and never allocate an instance,
 * which is the single largest performance win available here -- and it costs nothing at runtime,
 * because the work simply never starts.
 *
 * This is the predicate for POSING only. It deliberately says nothing about billboarding: a model
 * whose only moving part is a billboarded bone has no keys to sample, but still has to be turned to
 * face the camera each frame. Callers that build a per-frame set must ask both questions -- see
 * `doodad-manager.js#loadDoodad` and `world/index.ts#animateEntities`.
 *
 * QUARANTINE (lifted per sequence by Task 20): keys sitting in an EXTERNAL sequence slot are parsed
 * noise, not authoring, and are ignored here. A model whose only keys are noise must come out
 * static. Counting them would resurrect the erosion the lone-identity-key rule above exists to stop
 * -- only worse, since every external-heavy creature model in the game would flip to animated and
 * join the per-frame posing set to sample garbage.
 */
export function classify(data: M2AnimData, mergedSlots?: boolean[]): boolean {
  // `mergedSlots` overrides the flag-derived table. It has to exist: after Task 20 an external
  // sequence whose `.anim` has landed IS readable, and `flags` still says it is not -- `inline`
  // stops being a pure function of `flags` at the merge, and re-deriving it here would make the
  // recompute a no-op and silently strand every model whose only keys are external.
  const slots = mergedSlots || inlineSlots(data);

  const bones = data.bones || [];
  for (let i = 0, len = bones.length; i < len; ++i) {
    const bone = bones[i];
    if (blockAnimated(bone.translation, slots) ||
        blockAnimated(bone.rotation, slots) ||
        blockAnimated(bone.scaling, slots)) {
      return true;
    }
  }

  const uv = data.uvAnimations || [];
  for (let i = 0, len = uv.length; i < len; ++i) {
    if (blockAnimated(uv[i].translation, slots) ||
        blockAnimated(uv[i].rotation, slots) ||
        blockAnimated(uv[i].scaling, slots)) {
      return true;
    }
  }

  const transparency = data.transparencyAnimations || [];
  for (let i = 0, len = transparency.length; i < len; ++i) {
    if (blockAnimatedBeyondIdentity(transparency[i], isOpaque, slots)) {
      return true;
    }
  }

  const colors = data.vertexColorAnimations || [];
  for (let i = 0, len = colors.length; i < len; ++i) {
    if (blockAnimatedBeyondIdentity(colors[i].color, isWhite, slots) ||
        blockAnimatedBeyondIdentity(colors[i].alpha, isOpaque, slots)) {
      return true;
    }
  }

  return false;
}

/** Sequence flag 0x40: this sequence is an alias for the one `alias` points at. */
const FLAG_ALIAS = 0x40;

/**
 * Is this sequence an alias for another slot?
 *
 * Exported because it is what decides whether a QUARANTINED sequence has a `.anim` file to fetch.
 * An alias owns no keyframes -- it is a redirect -- so no sibling file is written for it, and
 * measured: `wolf0062-00.anim` and `kobold0136-00.anim`, the paths the two observed external
 * aliases would map to, both 404. Requesting them anyway costs a round trip per alias per creature
 * model and a console error each, for a file that cannot exist. Such a sequence stays
 * `inline: false` for ever, which is correct and already handled: `resolve` follows the alias to
 * its target and gates on the TARGET's inline bit.
 */
export function isAliasSequence(seq: Sequence): boolean {
  return (seq.flags & FLAG_ALIAS) !== 0;
}

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
/**
 * How many external `.anim` merges have succeeded ANYWHERE, across every loaded model.
 *
 * `mergeVersion` answers "has THIS model's playable shape changed?", which is the right question
 * once you already hold the model. The doodad managers hold thousands of placements and no cheap
 * way to know which of their models just gained data -- they need the cheaper question "is it worth
 * asking at all this frame?", and this is it. One integer compare per manager per frame in the
 * steady state; the O(loaded doodads) rescan behind it runs only on the frames a merge actually
 * landed on, which over a whole zone load is a handful.
 *
 * A free function rather than an exported `let`: an ES module binding read across a Jest module
 * registry is a snapshot in some transpile targets, and a counter that silently stops advancing
 * would reintroduce exactly the bug this exists to close.
 */
let mergeEpochCounter = 0;

export function externalMergeEpoch(): number {
  return mergeEpochCounter;
}

export class ModelAnim {
  readonly sequences: Sequence[] = [];
  readonly globalSequenceDurations: number[];
  /**
   * Does this model animate anything at all? NOT readonly, and no longer decided once.
   *
   * `classify()` only counts keys in an INLINE slot, so a model whose real authoring lives entirely
   * in sibling `.anim` files classifies static at load and must be re-classified the moment that
   * data lands -- otherwise it never joins the per-frame set and the merged keys are never sampled.
   * `mergeExternal` recomputes it; `M2#syncMergedAnimation` is what carries the flip out to a live
   * placement.
   */
  animated: boolean;
  /** Parsed bone defs, file order. A vertex's bone indices index this list. */
  readonly boneDefs: any[];

  /**
   * Bumped by every successful `mergeExternal`. The model's "shape of what is playable" revision.
   *
   * This exists so a live `InstanceAnim` can UN-LATCH `armable` without anybody holding a registry
   * of instances. `armDoodad` latches `armable = false` when the model owns nothing to play, which
   * was a permanent property of the model until this task made the table mutable. An instance
   * records the version it gave up at instead of a bare boolean, so a merge automatically makes it
   * armable again -- no listener list, no leak, no per-frame scan, and nothing to forget to call.
   */
  mergeVersion = 0;

  /** The parsed data, kept so `animated` can be recomputed after a merge. Same object, not a copy. */
  private readonly data: M2AnimData;

  /**
   * The upper-body split mask, built at most once per MODEL. `undefined` = not asked yet, `null` =
   * asked and this rig has no split key-bone (the client's `-1` sentinel).
   *
   * Cached here rather than on the instance because it is a property of the skeleton: a zone with
   * forty humanoids shares one mask, and it is read per bone per frame only for the handful of units
   * that actually have an overlay in flight.
   */
  private upperMask: Uint8Array | null | undefined = undefined;

  /**
   * Which bones a masked upper-body overlay drives -- see `anim/upper-body.ts` for where the
   * boundary comes from and the 3.3.5a measurement that pins it. `null` for a rig with no split.
   */
  upperBodyMask(): Uint8Array | null {
    if (this.upperMask === undefined) {
      this.upperMask = upperBodyMask(this.boneDefs);
    }
    return this.upperMask;
  }

  /** Every block that can carry per-sequence keys. Built on first merge, never per frame. */
  private blocks: MergeableBlock[] | null = null;

  /**
   * `inline` per FILE SLOT, kept in step with the sequence table so `classify` can be re-run.
   *
   * A parallel array rather than a walk of `sequences`, because `classify` indexes it by slot for
   * every track of every block and a per-recompute rebuild would be the only allocation on the
   * merge path that scales with the model.
   */
  private readonly slotInline: boolean[] = [];

  constructor(data: M2AnimData) {
    this.data = data;
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
        // Quarantine marker. External entries STAY in the table -- Task 20 merges their `.anim`
        // keys and flips this true; nothing here may drop or renumber a row, because `index` is the
        // file slot every animation block's `tracks` array is indexed by.
        inline: hasInlineData(a.flags),
      });
      this.slotInline.push(hasInlineData(a.flags));
    }

    this.globalSequenceDurations = data.sequences || [];
    this.animated = classify(data);
    this.boneDefs = data.bones || [];
  }

  /** Every animation block a sequence slot can index, gathered once. */
  private mergeableBlocks(): MergeableBlock[] {
    if (this.blocks) {
      return this.blocks;
    }
    const blocks: MergeableBlock[] = [];
    const push = (block: MergeableBlock | undefined) => {
      if (block && block.tracks) {
        blocks.push(block);
      }
    };

    const bones = this.data.bones || [];
    for (let i = 0, len = bones.length; i < len; ++i) {
      push(bones[i].translation);
      push(bones[i].rotation);
      push(bones[i].scaling);
    }
    const uv = this.data.uvAnimations || [];
    for (let i = 0, len = uv.length; i < len; ++i) {
      push(uv[i].translation);
      push(uv[i].rotation);
      push(uv[i].scaling);
    }
    const transparency = this.data.transparencyAnimations || [];
    for (let i = 0, len = transparency.length; i < len; ++i) {
      push(transparency[i]);
    }
    const colors = this.data.vertexColorAnimations || [];
    for (let i = 0, len = colors.length; i < len; ++i) {
      push(colors[i].color);
      push(colors[i].alpha);
    }

    this.blocks = blocks;
    return blocks;
  }

  /**
   * Merge a sibling `.anim` payload into a quarantined sequence and LIFT THE QUARANTINE for it.
   *
   * This is the one place `Sequence.inline` stops being a pure function of `flags`. Four things
   * happen, in this order, and all four are required:
   *
   *   1. the real keys are spliced into the existing `tracks[seq.index]` objects, in place -- the
   *      file slot is never dropped, renumbered or appended to;
   *   2. `inline` flips true, which is what makes `variationsOf` / `findById` / `resolve` /
   *      `classify` start admitting the slot at all;
   *   3. `animated` is RECOMPUTED, because the keys that just landed can be the first real keys the
   *      model has -- `classify` reads the inline-slot table, so it has to run after step 2;
   *   4. `mergeVersion` is bumped, which un-latches `armable` on every live instance of this model.
   *
   * Refusing is always safe: an unmerged sequence stays quarantined, which is the state everything
   * downstream already handles. So every guard below returns false rather than doing anything
   * partial.
   *
   * @returns whether the merge was applied.
   */
  mergeExternal(seq: Sequence, buffer: ArrayBuffer): boolean {
    // The wrong-rig guard that IS available. A `.anim` carries no bone count to compare against
    // (it has no header at all), but a `Sequence` handed in from a DIFFERENT model's table is a
    // reachable caller mistake, and its `index` would address a slot of this model's tracks that
    // belongs to some unrelated animation. Identity, not just range: two models routinely have a
    // slot 19.
    if (this.sequences[seq.index] !== seq) {
      return false;
    }
    if (seq.inline) {
      return false;
    }

    const merged = mergeExternalAnim(this.mergeableBlocks(), seq.index, seq.lengthMs, buffer);
    if (merged === MERGE_REJECTED || merged <= 0) {
      return false;
    }

    seq.inline = true;
    this.slotInline[seq.index] = true;
    // AFTER the flip, and driven by the live table rather than by `flags` -- see `classify`.
    this.animated = classify(this.data, this.slotInline);
    ++this.mergeVersion;
    // The GLOBAL counterpart, read by the doodad managers to decide whether a static->animated
    // rescan is worth running this frame. See `externalMergeEpoch`.
    ++mergeEpochCounter;
    return true;
  }

  /**
   * Every PLAYABLE sequence sharing an `AnimationData.dbc` id -- the variation set.
   *
   * Quarantined (external) entries are withheld: their slots hold parsed noise, so picking one
   * poses the model from garbage. Task 20 lifts this per sequence. An id whose every variation is
   * external therefore returns empty, and `pickVariation` returns null -- correct, because the
   * caller has nothing safe to play.
   */
  variationsOf(animId: number): Sequence[] {
    const out: Sequence[] = [];
    for (let i = 0, len = this.sequences.length; i < len; ++i) {
      if (this.sequences[i].id === animId && this.sequences[i].inline) {
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
   * refusing to pick would freeze them instead of animating them uniformly. That branch's
   * `roll % variations.length` is safe under the quarantine only because the empty check above runs
   * FIRST -- filtering `variationsOf` down to nothing must return null, never divide by zero.
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

    // NO modulo on `roll`. Wrapping it back into the distribution biases mass toward the first
    // variation, and makes the trailing clamp unreachable. `roll` comes from a stream returning
    // [0, 32767] and an id's weights conventionally sum to 32767, so `roll >= total` is reachable at
    // the boundary; clamping there is correct and wrapping is a real distribution bug.
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
   *
   * QUARANTINE (lifted per sequence by Task 20). One gate, at the EXIT: whatever the walk lands on
   * must be inline or it is discarded, and the fallback is the first INLINE sequence rather than
   * `sequences[0]`, which is not guaranteed inline. Gating only at lookup would not be enough --
   * `sequences[current.alias]` is a raw slot index, so an inline alias can still point at a
   * quarantined target. A model with no inline sequence at all resolves to null; the caller must
   * already handle that, since a model with no sequences does too.
   *
   * `fallback = false` asks the narrower question "does this model OWN a playable clip for this
   * id?", returning null instead of Stand. That is what a candidate-list walk needs
   * (`Unit#updateLocomotion`): stepping Run -> Walk requires distinguishing "no Run" from "Run",
   * and comparing the returned sequence's `id` against the requested one cannot do it -- an alias
   * hop legitimately lands on a target carrying a different id, which would then be misread as
   * absent. The alias walk still runs; only the final `firstInline()` consolation is withheld.
   */
  resolve(requestedId: number, fallback: boolean = true): Sequence | null {
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

    if (current && current.inline) {
      return current;
    }
    return fallback ? this.firstInline() : null;
  }

  /**
   * The declared entry for an id, preferring a playable one.
   *
   * Returns an inline match when the id has one, so an id whose FIRST variation is external but
   * whose second is inline still plays instead of collapsing to Stand. Falls back to an external
   * match rather than null, because an alias entry has no keys of its own and may legitimately
   * carry no inline bit -- the walk in `resolve` must still get to start, and `resolve`'s exit gate
   * is what makes returning an external entry from here safe.
   */
  private findById(animId: number): Sequence | null {
    let external: Sequence | null = null;
    for (let i = 0, len = this.sequences.length; i < len; ++i) {
      const seq = this.sequences[i];
      if (seq.id !== animId) {
        continue;
      }
      if (seq.inline) {
        return seq;
      }
      if (!external) {
        external = seq;
      }
    }
    return external;
  }

  /** The first sequence whose keyframes are actually in this file, or null if there is none. */
  private firstInline(): Sequence | null {
    for (let i = 0, len = this.sequences.length; i < len; ++i) {
      if (this.sequences[i].inline) {
        return this.sequences[i];
      }
    }
    return null;
  }

  /**
   * The cursor for a global-sequence channel at a given world time.
   *
   * Lives on the MODEL, not the instance. A global sequence is clock-driven with zero arming
   * (benilla `doodad_anim.rs:9`) -- it is a pure function of world time, so every placement of a
   * model computes an identical value. Hoisting it here means a courtyard of a hundred braziers
   * evaluates its glow pulse once instead of a hundred times.
   *
   * This is a deliberate divergence from WebWoWViewer, which keeps `globalSequenceTimes` per
   * instance -- per-instance state that provably cannot differ between instances.
   */
  globalSequenceCursor(gseqIndex: number, worldClockMs: number): number {
    const duration = this.globalSequenceDurations[gseqIndex];
    if (duration === undefined || duration <= 0) {
      return 0;
    }
    return cursorMs(WRAP, worldClockMs, duration);
  }
}
