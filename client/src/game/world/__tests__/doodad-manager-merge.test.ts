/**
 * `DoodadManager#adoptMergedAnimations` -- the static -> animated flip for TERRAIN doodads.
 *
 * The mirror of `WMO#adoptMergedAnimations`, and tested separately on purpose: the two are
 * structurally identical, which is exactly the situation in which a fix lands on one path and not
 * the other. Everything about the failure mode is documented on the WMO test.
 *
 * jsdom, not node: importing `world/doodad-manager` pulls in `M2Blueprint` -> `M2` ->
 * `cache-manager`, whose module-level singleton touches `window.indexedDB` at import time.
 *
 * @jest-environment jsdom
 */
import DoodadManager from '../doodad-manager';
import M2 from '../../pipeline/m2';
import { externalMergeEpoch, ModelAnim } from '../../pipeline/m2/anim/model-anim';
import { worldClock } from '../../pipeline/m2/anim/world-clock';

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: 0, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

/** Every sequence quarantined (`flags: 0`), plus the bone refs a real `mergeExternal` re-reads. */
const externalOnlyModelAnim = () => new ModelAnim({
  animations: [animation()],
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

/** A placement of an external-only model: static at load, carrying the real flip method. */
const externalDoodad = (m: any) => ({
  poseSlot: -1,
  poseFrame: 0,
  visible: false,
  billboards: [] as any[],
  animated: false,
  modelAnim: m,
  instanceAnim: null as any,
  syncMergedAnimation: (M2 as any).prototype.syncMergedAnimation,
});

/**
 * Called on the prototype against a hand-built `this`. `new DoodadManager(...)` starts two load
 * intervals and reaches into the world map, none of which the membership decision involves -- and a
 * test that paid for it would leak timers into the rest of the suite.
 */
const manager = (entries: Array<[number, any]>) => ({
  view: { visible: true },
  doodads: new Map<number, any>(entries),
  animatedDoodads: new Map<number, any>(),
  nextPoseSlot: 0,
  lastMergeEpoch: externalMergeEpoch(),
  boneBudget: { beginFrame() { /* no budget under test */ } },
  adoptMergedAnimations: (DoodadManager as any).prototype.adoptMergedAnimations,
  enableDoodadAnimations: (DoodadManager as any).prototype.enableDoodadAnimations,
  animate: (DoodadManager as any).prototype.animate,
});

const camera = { position: { x: 0, y: 0, z: 0 } };

describe('DoodadManager#adoptMergedAnimations', () => {
  beforeEach(() => worldClock.reset());

  /**
   * MUTATION KILLED: leaving the terrain path un-fixed while fixing the WMO one, and dropping the
   * `syncMergedAnimation()` re-ask from the rescan body. Driven through `animate` so it also kills
   * deleting the call site -- a correct rescan that never runs is the same silent bind pose.
   *
   * The assertion is on MEMBERSHIP and the allocated instance, never on a pose: an unarmed instance
   * samples cursor 0 and reads bind pose, so a pose assertion would prove nothing.
   */
  it('admits a static terrain doodad once its external .anim merges', () => {
    const m = externalOnlyModelAnim();
    const d = externalDoodad(m);
    const dm = manager([[41, d]]);

    dm.animate(0.016, camera, false);
    expect(dm.animatedDoodads.has(41)).toBe(false);
    expect(d.instanceAnim).toBeNull();

    expect(m.mergeExternal(m.sequences[0], externalPayload())).toBe(true);

    dm.animate(0.016, camera, false);

    expect(dm.animatedDoodads.get(41)).toBe(d);
    expect(d.animated).toBe(true);
    expect(d.instanceAnim).not.toBeNull();
    // A dense phase slot, not the sparse entry id: `undefined` makes `shouldPose` NaN, and the
    // doodad is then never posed at all, silently.
    expect(d.poseSlot).toBe(0);
  });

  /**
   * MUTATION KILLED: dropping the epoch gate. Without it this is an O(loaded doodads) walk in the
   * per-frame path -- every doodad in a streamed zone, every frame, for a flip that happens a
   * handful of times per zone load. The spec forbids exactly this in the hot loop.
   */
  it('does not walk the doodad map on a frame where nothing merged', () => {
    const m = externalOnlyModelAnim();
    const d: any = externalDoodad(m);
    const spy = jest.fn();
    d.syncMergedAnimation = spy;

    const dm = manager([[41, d]]);
    dm.animate(0.016, camera, false);
    dm.animate(0.016, camera, false);

    expect(spy).not.toHaveBeenCalled();
  });
});
