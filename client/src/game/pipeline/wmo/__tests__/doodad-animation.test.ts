/**
 * jsdom, not node: importing `pipeline/wmo` pulls in `M2Blueprint` -> `M2` -> `cache-manager`, whose
 * module-level singleton touches `window.indexedDB` at import time.
 *
 * @jest-environment jsdom
 */
import WMO from '../index';
import { animCounters } from '../../m2/anim/counters';
import { InstanceAnim } from '../../m2/anim/instance-anim';
import { ModelAnim } from '../../m2/anim/model-anim';
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

    wmo.enableDoodadAnimations({ id: 4127 }, d);

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

    wmo.enableDoodadAnimations({ id: 4127 }, ds[0]);
    wmo.enableDoodadAnimations({ id: 9302 }, ds[1]);
    wmo.enableDoodadAnimations({ id: 9311 }, ds[2]);

    expect(ds.map((d) => d.poseSlot)).toEqual([0, 1, 2]);
  });

  /** Kills: skipping the initial `armDoodad`, which would leave every interior prop in bind pose. */
  it('arms the instance against the shared world clock', () => {
    const wmo = registrar();
    const d = doodad();
    worldClock.reset();
    worldClock.advance(2);

    wmo.enableDoodadAnimations({ id: 1 }, d);

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

    expect(() => wmo.enableDoodadAnimations({ id: 7 }, d)).not.toThrow();
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
    animatedDoodads: new Map<number, any>(members.map((m, i) => [i, m])),
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
