/**
 * jsdom, not node: importing `pipeline/wmo` pulls in `M2Blueprint` -> `M2` -> `cache-manager`, whose
 * module-level singleton touches `window.indexedDB` at import time.
 *
 * @jest-environment jsdom
 */
import WMO from '../index';
import M2 from '../../m2';
import { animCounters } from '../../m2/anim/counters';
import { InstanceAnim } from '../../m2/anim/instance-anim';
import { externalMergeEpoch, ModelAnim } from '../../m2/anim/model-anim';
import { worldClock } from '../../m2/anim/world-clock';

/** `0x20` = keyframes inline in the .m2. Without it `ModelAnim` quarantines the sequence as
 *  external, and nothing can arm it -- see `hasInlineData`. */
const INLINE = 0x20;

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: INLINE, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

const modelAnim = (over: any = {}) => new ModelAnim({
  animations: [animation()], sequences: [], bones: [], ...over,
});

/**
 * Called on the prototype against a hand-built `this`.
 *
 * `new WMO(...)` starts two `ContentQueue` timers and reaches for the root loader; none of that is
 * involved in the registration decision, and a test that paid for it would leak intervals into the
 * rest of the suite.
 */
const registrar = () => ({
  animatedDoodads: new Map<number, any>(),
  nextPoseSlot: 0,
  enableDoodadAnimations: (WMO as any).prototype.enableDoodadAnimations,
});

const doodad = (over: any = {}) => ({
  poseSlot: -1,
  poseFrame: 0,
  billboards: [],
  animated: true,
  instanceAnim: new InstanceAnim(modelAnim()),
  ...over,
});

describe('WMO#enableDoodadAnimations', () => {
  /**
   * Kills: leaving the registration out (the Task 13 state, where `animatedDoodads` stayed empty
   * for ever and `WMO#animate` iterated nothing). Nothing else in the client observes membership,
   * so a deleted registration is otherwise a completely silent no-op.
   */
  it('puts the doodad in the per-frame set', () => {
    const wmo = registrar();
    const d = doodad({ poseFrame: 99 });

    wmo.enableDoodadAnimations(4127, d);

    expect(wmo.animatedDoodads.get(4127)).toBe(d);
    // Kills: dropping the `poseFrame = -1` reset. A recycled doodad carrying a stale frame index
    // that happens to equal the current one gets a scene walk it did not earn; one that never
    // matches never gets the walk its pose needs. `-1` is the only value no real frame equals.
    expect(d.poseFrame).toBe(-1);
  });

  /**
   * Kills: dropping the `poseSlot` assignment, or phasing on the doodad ENTRY id instead. Entry ids
   * here are `doodadIndex`, which is sparse and clustered per group; slots must be a dense 0, 1, 2
   * regardless of what the ids are. Before `poseSlot` was declared on `M2` a missing assignment left
   * it `undefined`, which makes `(frameIndex + undefined) % period` NaN -- never `=== 0`, so the
   * doodad would never have been posed and nothing would have said so.
   */
  it('hands out dense pose slots, not the sparse entry ids', () => {
    const wmo = registrar();
    const ds = [doodad(), doodad(), doodad()];

    wmo.enableDoodadAnimations(4127, ds[0]);
    wmo.enableDoodadAnimations(9302, ds[1]);
    wmo.enableDoodadAnimations(9311, ds[2]);

    expect(ds.map((d) => d.poseSlot)).toEqual([0, 1, 2]);
  });

  /** Kills: skipping the initial `armDoodad`, which would leave every interior prop in bind pose. */
  it('arms the instance against the shared world clock', () => {
    const wmo = registrar();
    const d = doodad();
    worldClock.reset();
    worldClock.advance(2);

    wmo.enableDoodadAnimations(1, d);

    expect(d.instanceAnim.current).not.toBeNull();
    expect(d.instanceAnim.armedAtMs).toBe(worldClock.ms);
  });

  /**
   * Kills: dereferencing `instanceAnim` unconditionally. Membership is
   * `animated || billboards.length > 0`, so a doodad whose only moving part is a billboarded bone
   * is a member with a NULL instance -- and it must still be registered, or it stops being turned to
   * face the camera and freezes in bind orientation.
   */
  it('registers a billboard-only doodad, which has no instance to arm', () => {
    const wmo = registrar();
    const d = doodad({ animated: false, instanceAnim: null, billboards: [{}] });

    expect(() => wmo.enableDoodadAnimations(7, d)).not.toThrow();
    expect(wmo.animatedDoodads.get(7)).toBe(d);
    expect(d.poseSlot).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
// `WMO#animate` -- the loop ordering.
//
// Four gates in a fixed order (residency cycle -> draw -> material channels -> bone work), and every
// mis-ordering is a SILENT no-op rather than a crash. Three of the plan's earlier tasks shipped one.
// -------------------------------------------------------------------------------------------------

/** A doodad rich enough to be driven through the whole loop, recording what was called on it. */
const member = (over: any = {}) => {
  const elements = new Array(16).fill(0);
  elements[0] = 1; elements[5] = 1; elements[10] = 1; elements[15] = 1;

  const d: any = {
    visible: true,
    animated: true,
    useSkinning: true,
    billboards: [] as any[],
    poseSlot: 0,
    poseFrame: -1,
    matrixWorld: { elements },
    instanceAnim: new InstanceAnim(modelAnim()),
    materialCalls: 0,
    poseCalls: 0,
    billboardCalls: 0,
    evaluateMaterialChannels() { d.materialCalls++; },
    applyPose() { d.poseCalls++; },
    applyBillboards() { d.billboardCalls++; },
    ...over,
  };

  return d;
};

const animator = (members: any[]) => {
  const wmo: any = {
    views: { root: {} },
    doodads: new Map<number, any>(members.map((m, i) => [i, m])),
    animatedDoodads: new Map<number, any>(members.map((m, i) => [i, m])),
    // `animate` opens with the merge-adoption rescan; every member here is already registered, so
    // it is a no-op, but the method has to exist for the loop under test to reach its own body.
    lastMergeEpoch: -1,
    adoptMergedAnimations: (WMO as any).prototype.adoptMergedAnimations,
    animate: (WMO as any).prototype.animate,
  };
  return wmo;
};

const camera = { position: { x: 0, y: 0, z: 0 } };

describe('WMO#animate loop ordering', () => {
  beforeEach(() => {
    animCounters.reset();
    worldClock.reset();
  });

  /**
   * Kills: returning early on a null `instanceAnim` -- which is what the brief's snippet did.
   *
   * Membership is `animated || billboards.length > 0`, so a doodad whose only moving part is a
   * billboarded bone is a member with NO instance. Bailing on it stops it being turned to face the
   * camera and freezes it in bind orientation, while every counter still reads plausibly.
   */
  it('reaches applyBillboards for a billboard-only member with no instance', () => {
    const d = member({ animated: false, instanceAnim: null, billboards: [{}] });

    animator([d]).animate(0.016, camera, true, null);

    expect(d.billboardCalls).toBe(1);
    expect(d.poseCalls).toBe(0);
    expect(d.materialCalls).toBe(0);
    // No instance means nothing to count as resident -- it is not an animated instance at all.
    expect(animCounters.resident).toBe(0);
    // Billboarding moved it, so it must still earn the scene walk.
    expect(d.poseFrame).toBe(worldClock.frameIndex);
  });

  /**
   * Kills: re-gating the material channels behind `useSkinning` (or behind the pose gates).
   *
   * A scrolling waterfall or a pulsing glow typically animates no bone at all, so `useSkinning` is
   * false while `classify()` is true. Folding the channels in with the bone work stops it scrolling
   * and leaves nothing to notice: the doodad still draws, still has a live instance, and the pose
   * counters still look right.
   */
  it('evaluates material channels for a UV-only member that skips the bone work', () => {
    const d = member({ useSkinning: false });

    animator([d]).animate(0.016, camera, false, null);

    expect(d.materialCalls).toBe(1);
    expect(d.poseCalls).toBe(0);
    expect(animCounters.materialsEvaluated).toBe(1);
    expect(animCounters.resident).toBe(1);
    // Nothing moved, so no scene walk is owed.
    expect(d.poseFrame).toBe(-1);
  });

  /** Kills: collapsing the draw gate into the residency gate. */
  it('cycles an undrawn member but does not pose or sample it', () => {
    const d = member({ visible: false });

    animator([d]).animate(0.016, camera, true, null);

    // The variation cycle is gated on RESIDENCY, not the draw -- it armed even though nothing drew.
    expect(d.instanceAnim.current).not.toBeNull();
    expect(d.materialCalls).toBe(0);
    expect(d.poseCalls).toBe(0);
    expect(d.billboardCalls).toBe(0);
    expect(animCounters.resident).toBe(1);
    expect(animCounters.skipped).toBe(1);
  });

  /** Kills: dropping the `poseFrame` stamp, which strands a posed doodad in its last matrix. */
  it('poses a drawn, skinned member and stamps it for the scene walk', () => {
    const d = member();

    animator([d]).animate(0.016, camera, false, null);

    expect(d.poseCalls).toBe(1);
    expect(d.materialCalls).toBe(1);
    expect(d.poseFrame).toBe(worldClock.frameIndex);
    expect(animCounters.posed).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------------
// `WMO#adoptMergedAnimations` -- the static -> animated flip.
//
// `loadDoodad` decides membership ONCE, from `doodad.animated`, which is `classify()` over INLINE
// slots only. A model authored entirely in sibling `.anim` files reads static there. Until this
// existed, `M2#syncMergedAnimation` had exactly one caller (the unit path), so such a doodad joined
// no per-frame set and nothing ever re-asked -- bind pose for ever, with correct merged keys in the
// table beside it, and no error anywhere.
// -------------------------------------------------------------------------------------------------

/** Every sequence quarantined, plus the bone refs a real `mergeExternal` re-reads. */
const externalOnlyModelAnim = () => new ModelAnim({
  animations: [animation({ id: 0, flags: 0, length: 1000 })],
  sequences: [],
  bones: [{
    parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
    translation: {
      interpolationType: 1, globalSequenceID: -1, valueTypeName: 'float32array3',
      tracks: [{
        animationIndex: 0, timestamps: [3197923783], values: [[9, 9, 9]],
        timestampsRef: { count: 2, offset: 0 }, valuesRef: { count: 2, offset: 8 },
      }],
    },
    rotation: { interpolationType: 1, globalSequenceID: -1, tracks: [] },
    scaling: { interpolationType: 1, globalSequenceID: -1, tracks: [] },
  }],
} as any);

const externalPayload = () => {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  view.setUint32(0, 0, true);
  view.setUint32(4, 1000, true);
  [7, 0, 0, 8, 1, 2].forEach((v, i) => view.setFloat32(8 + i * 4, v, true));
  return buffer;
};

/** A placement of an external-only model: static at load, with the real flip method on it. */
const externalDoodad = (m: any) => ({
  poseSlot: -1,
  poseFrame: 0,
  billboards: [] as any[],
  animated: false,
  modelAnim: m,
  instanceAnim: null as any,
  syncMergedAnimation: (M2 as any).prototype.syncMergedAnimation,
});

const adopter = (entries: Array<[number, any]>) => ({
  doodads: new Map<number, any>(entries),
  animatedDoodads: new Map<number, any>(),
  nextPoseSlot: 0,
  lastMergeEpoch: externalMergeEpoch(),
  adoptMergedAnimations: (WMO as any).prototype.adoptMergedAnimations,
  enableDoodadAnimations: (WMO as any).prototype.enableDoodadAnimations,
});

describe('WMO#adoptMergedAnimations', () => {
  beforeEach(() => worldClock.reset());

  /**
   * MUTATION KILLED: deleting the `adoptMergedAnimations()` call from `WMO#animate`, or dropping
   * the `syncMergedAnimation()` re-ask from inside it. Both leave the doodad out of
   * `animatedDoodads` for ever -- the silent failure this closes.
   *
   * The assertions are on MEMBERSHIP and on the allocated instance, not on a pose: an unarmed
   * instance samples cursor 0 and reads bind pose, so a pose assertion would prove nothing here.
   */
  it('admits a static doodad once its external .anim merges', () => {
    const m = externalOnlyModelAnim();
    const d = externalDoodad(m);
    const wmo = adopter([[7, d]]);

    // Before the merge there is nothing to adopt, whatever the epoch says.
    wmo.lastMergeEpoch = -1;
    wmo.adoptMergedAnimations();
    expect(wmo.animatedDoodads.has(7)).toBe(false);
    expect(d.instanceAnim).toBeNull();

    expect(m.mergeExternal(m.sequences[0], externalPayload())).toBe(true);

    wmo.adoptMergedAnimations();

    expect(wmo.animatedDoodads.get(7)).toBe(d);
    expect(d.animated).toBe(true);
    expect(d.instanceAnim).not.toBeNull();
    // Registered properly, not just inserted: an undefined phase slot makes `shouldPose` NaN and
    // the doodad is never posed at all, silently.
    expect(d.poseSlot).toBe(0);
  });

  /**
   * The same flip, driven through `WMO#animate` rather than by calling the rescan directly.
   *
   * MUTATION KILLED: deleting `this.adoptMergedAnimations()` from `WMO#animate`. The rescan can be
   * perfectly correct and still never run, which is precisely the shape of the bug it fixes -- the
   * unit path had `syncMergedAnimation` and the doodad paths simply never called it.
   *
   * `visible: false` so the doodad stops at the draw gate: this test is about membership and the
   * residency cycle, and a fully-driven loop would need pose plumbing that proves nothing here.
   */
  it('adopts the flip from inside the per-frame loop, not only when called directly', () => {
    const m = externalOnlyModelAnim();
    const d: any = externalDoodad(m);
    d.visible = false;

    const wmo: any = animator([]);
    wmo.doodads = new Map<number, any>([[7, d]]);
    wmo.nextPoseSlot = 0;
    wmo.enableDoodadAnimations = (WMO as any).prototype.enableDoodadAnimations;
    wmo.lastMergeEpoch = externalMergeEpoch();

    wmo.animate(0.016, camera, false, null);
    expect(wmo.animatedDoodads.has(7)).toBe(false);

    expect(m.mergeExternal(m.sequences[0], externalPayload())).toBe(true);

    wmo.animate(0.016, camera, false, null);

    expect(wmo.animatedDoodads.get(7)).toBe(d);
    expect(d.instanceAnim).not.toBeNull();
  });

  /**
   * MUTATION KILLED: dropping the epoch gate, which turns this into an O(loaded doodads) walk in
   * the per-frame path -- in a city, the whole interior population of every building, every frame,
   * for a flip that happens a handful of times per zone load.
   */
  it('does not walk the doodad map on a frame where nothing merged', () => {
    const m = externalOnlyModelAnim();
    const d = externalDoodad(m);
    const spy = jest.fn();
    d.syncMergedAnimation = spy;

    const wmo = adopter([[7, d]]);
    wmo.adoptMergedAnimations();
    wmo.adoptMergedAnimations();

    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * MUTATION KILLED: re-registering a doodad that is already in the set -- which would hand it a
   * SECOND `poseSlot` and re-`armDoodad` it, resetting its clock to now. A looping doodad would
   * visibly snap back to its first keyframe every time any model anywhere merged an `.anim`.
   */
  it('leaves an already-registered doodad alone', () => {
    const m = externalOnlyModelAnim();
    const d = externalDoodad(m);
    const wmo = adopter([[7, d]]);

    expect(m.mergeExternal(m.sequences[0], externalPayload())).toBe(true);
    wmo.adoptMergedAnimations();
    expect(d.poseSlot).toBe(0);

    const other = externalOnlyModelAnim();
    expect(other.mergeExternal(other.sequences[0], externalPayload())).toBe(true);
    wmo.adoptMergedAnimations();

    expect(d.poseSlot).toBe(0);
    expect(wmo.nextPoseSlot).toBe(1);
  });
});
