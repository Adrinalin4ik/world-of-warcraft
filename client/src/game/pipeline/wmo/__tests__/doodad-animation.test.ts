/**
 * jsdom, not node: importing `pipeline/wmo` pulls in `M2Blueprint` -> `M2` -> `cache-manager`, whose
 * module-level singleton touches `window.indexedDB` at import time.
 *
 * @jest-environment jsdom
 */
import WMO from '../index';
import { InstanceAnim } from '../../m2/anim/instance-anim';
import { ModelAnim } from '../../m2/anim/model-anim';
import { worldClock } from '../../m2/anim/world-clock';

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: 0, probability: 32767,
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
    const d = doodad();

    wmo.enableDoodadAnimations({ id: 4127 }, d);

    expect(wmo.animatedDoodads.get(4127)).toBe(d);
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
