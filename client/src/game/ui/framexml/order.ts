/**
 * The client's draw order, as one total order over a per-quad key.
 *
 * THE ORDER IS FLAT, NOT HIERARCHICAL. There is no "draw a frame, then its children" walk: every
 * visible quad is an independent entry ranked by this key, so a child frame in a lower strata draws
 * BEFORE its parent.
 *
 * Two ranks in here are counterintuitive and both have a visual signature that reads as an art bug:
 *
 *  - The DRAW LAYER outranks the frame. A bucket emits every frame's BACKGROUND, then every frame's
 *    BORDER, and so on -- regions are not grouped behind the frame that owns them. This is also why
 *    `SetFrameLevel(GetFrameLevel() - 1)` is a real FrameXML idiom: a child is born at parent + 1, so
 *    -1 makes a TIE, and the tie exists precisely so the layer rank can decide.
 *  - All textures of a layer precede all its font strings, across frames.
 *
 * benilla packs these fields into a u64 and sorts integers. JS has no u64, and a BigInt per quad per
 * frame is exactly the allocation the renderer's mesh pool exists to avoid -- so this is a
 * field-by-field comparator instead. Same total order, no garbage. The packing is the reference's
 * implementation detail; the ORDER is the contract.
 */

/**
 * Frame strata, lowest first. A separate and higher-ranked axis than the draw layer.
 *
 * OURS is a subset of the client's ten: we drop `WORLD` (the client's id 0, below `BACKGROUND`,
 * for the 3D world layer -- nothing a glue screen draws) and `BLIZZARD` (the client's id 9, above
 * `TOOLTIP`, a modern-engine addition no 1.12 content selects). Relative order among the eight we
 * keep is identical to the client's, so nothing renders differently -- but two things follow from
 * the drop and neither is cosmetic: our index into this array is NOT the client's bucket id (our
 * `MEDIUM` is index 2, the client's ctor value is 3), so any future index-to-bucket-id mapping is
 * off by one; and `SetFrameStrata("WORLD")` from Lua (plan 2) hits `indexOf === -1` here,
 * indistinguishable from a typo in the strata name.
 */
export type Strata =
  | 'BACKGROUND'
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'DIALOG'
  | 'FULLSCREEN'
  | 'FULLSCREEN_DIALOG'
  | 'TOOLTIP';

export const STRATA_ORDER: Strata[] = [
  'BACKGROUND',
  'LOW',
  'MEDIUM',
  'HIGH',
  'DIALOG',
  'FULLSCREEN',
  'FULLSCREEN_DIALOG',
  'TOOLTIP',
];

/** The five draw layers within a frame level. NOT a place for DIALOG -- that is a strata. */
export type DrawLayer = 'BACKGROUND' | 'BORDER' | 'ARTWORK' | 'OVERLAY' | 'HIGHLIGHT';

export const DRAW_LAYER_ORDER: DrawLayer[] = [
  'BACKGROUND',
  'BORDER',
  'ARTWORK',
  'OVERLAY',
  'HIGHLIGHT',
];

export type OrderKey = {
  strata: Strata;
  frameLevel: number;
  layer: DrawLayer;
  isFontString: boolean;
  /**
   * The owning frame's position in its bucket's live list -- NOT its creation index. Re-stamped to
   * the tail when a frame is shown, changes strata, or has its level CHANGED (a same-value
   * `SetFrameLevel` must not re-stamp). Without this, a frame declared early and shown late draws
   * under what it should cover.
   */
  linkStamp: number;
  /**
   * The region's index within the frame that owns it.
   *
   * OURS to drop, not the client's: the reference has an `is-region` rank between `linkStamp` and
   * `declarationSeq` that we do not implement here. Unlike sub-level, this omission is not in the
   * plan's "Follow-ups this plan deliberately leaves".
   */
  declarationSeq: number;
};

export function compareOrder(a: OrderKey, b: OrderKey): number {
  return (
    STRATA_ORDER.indexOf(a.strata) - STRATA_ORDER.indexOf(b.strata) ||
    a.frameLevel - b.frameLevel ||
    DRAW_LAYER_ORDER.indexOf(a.layer) - DRAW_LAYER_ORDER.indexOf(b.layer) ||
    Number(a.isFontString) - Number(b.isFontString) ||
    a.linkStamp - b.linkStamp ||
    a.declarationSeq - b.declarationSeq
  );
}
