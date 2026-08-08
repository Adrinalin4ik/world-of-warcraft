/** @jest-environment node */
import { animCounters } from '../counters';
import { BoneBudget } from '../gating';
import { InstanceAnim } from '../instance-anim';
import { ModelAnim } from '../model-anim';
import { poseGatedInstance, PoseTarget } from '../pose-gate';

/**
 * `0x20` = keyframes inline in this .m2, as wolf Stand/Walk/Run really carry.
 *
 * These tests arm a sequence by hand rather than through `resolve`/`pickVariation`, so they would
 * pass with `flags: 0` too -- but `flags: 0` means EXTERNAL, and `ModelAnim` quarantines it
 * (`hasInlineData`). A fixture on that value describes a model that cannot reach these code paths.
 * `0x20` leaves bit 0 alone, so no clock law moves.
 */
const INLINE = 0x20;

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: INLINE, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

const bone = (over: any = {}) => ({
  parentID: -1, billboarded: false, pivotPoint: [0, 0, 0],
  translation: { interpolationType: 1, globalSequenceID: -1, tracks: [] },
  rotation: { interpolationType: 1, globalSequenceID: -1, tracks: [] },
  scaling: { interpolationType: 1, globalSequenceID: -1, tracks: [] },
  ...over,
});

const model = (boneCount: number) => new ModelAnim({
  animations: [animation()],
  sequences: [],
  bones: new Array(boneCount).fill(null).map(() => bone()),
});

/**
 * A pose target whose `matrixWorld` translation and whose `position` DISAGREE.
 *
 * That disagreement is the point: a WMO doodad's `position` is local to its building and a unit
 * model's is local to its `view`, so a gate reading `position` measures a distance the camera never
 * had. Every fixture here puts `position` at the origin and the world translation far away.
 */
function target(worldXYZ: [number, number, number], poseSlot: number) {
  const elements = new Array(16).fill(0);
  elements[0] = 1; elements[5] = 1; elements[10] = 1; elements[15] = 1;
  elements[12] = worldXYZ[0];
  elements[13] = worldXYZ[1];
  elements[14] = worldXYZ[2];

  const t = {
    matrixWorld: { elements },
    position: { x: 0, y: 0, z: 0 },
    poseSlot,
    applied: 0,
    applyPose() { t.applied++; },
  };

  return t as typeof t & PoseTarget;
}

const ORIGIN = { x: 0, y: 0, z: 0 };

const armed = (m: ModelAnim) => {
  const inst = new InstanceAnim(m);
  inst.arm(m.sequences[0], 0);
  return inst;
};

beforeEach(() => animCounters.reset());

describe('poseGatedInstance distance gate', () => {
  /**
   * Kills: reading `doodad.position` instead of `matrixWorld` for the distance. With `position` at
   * the origin the instance measures 0 yd, takes period 1, and would be posed on every frame --
   * including frame 1, where the real 200 yd distance and slot 0 say no.
   */
  it('measures distance from the world matrix translation, not from `position`', () => {
    const inst = armed(model(3));
    const far = target([200, 0, 0], 0);

    expect(poseGatedInstance(far, inst, ORIGIN, 0, 0, null)).toBe(true);
    expect(poseGatedInstance(far, inst, ORIGIN, 1, 0, null)).toBe(false);
    expect(far.applied).toBe(1);
  });

  /**
   * Kills: dropping the `poseSlot` argument (or feeding a constant). Four instances at 200 yd take
   * period 4; with the slot honoured exactly one of them is posed on any given frame, and with it
   * ignored all four land on the same frame -- the single-phase pile-up the stagger exists to
   * prevent.
   */
  it('staggers instances by pose slot rather than posing them all on one frame', () => {
    const m = model(3);
    const insts = [0, 1, 2, 3].map(() => armed(m));
    const targets = [0, 1, 2, 3].map((slot) => target([200, 0, 0], slot));

    const perFrame = [0, 1, 2, 3].map((frame) => targets.filter(
      (t, i) => poseGatedInstance(t, insts[i], ORIGIN, frame, 0, null),
    ).length);

    expect(perFrame).toEqual([1, 1, 1, 1]);
    expect(targets.map((t) => t.applied)).toEqual([1, 1, 1, 1]);
  });

  /** Kills: gating a near instance at all. Inside NEAR_YD every frame poses, whatever the slot. */
  it('poses a near instance every frame', () => {
    const inst = armed(model(3));
    const near = target([10, 0, 0], 1);

    for (let frame = 0; frame < 4; ++frame) {
      expect(poseGatedInstance(near, inst, ORIGIN, frame, 0, null)).toBe(true);
    }
    expect(near.applied).toBe(4);
  });
});

describe('poseGatedInstance bone budget', () => {
  /**
   * Kills: ignoring the budget's verdict -- charging it but posing anyway. The second instance is
   * over the limit, so it must NOT have `applyPose` called and must NOT contribute bones solved.
   */
  it('denies an instance that would overrun the budget, and does not pose it', () => {
    const m = model(30);
    const budget = new BoneBudget(40);
    budget.beginFrame();

    const first = target([1, 0, 0], 0);
    const second = target([1, 0, 0], 1);

    expect(poseGatedInstance(first, armed(m), ORIGIN, 0, 0, budget)).toBe(true);
    expect(poseGatedInstance(second, armed(m), ORIGIN, 0, 0, budget)).toBe(false);

    expect(first.applied).toBe(1);
    expect(second.applied).toBe(0);
    expect(animCounters.bonesSolved).toBe(30);
    expect(animCounters.posed).toBe(1);
    expect(animCounters.skipped).toBe(1);
  });

  /**
   * Kills: treating a null budget as an empty `BoneBudget` (limit 0), which would deny every
   * instance after the first. This is the exemption units are admitted through, so a regression here
   * would freeze every creature past the first one on screen.
   */
  it('charges and denies nothing when the budget is null', () => {
    const m = model(30);
    const targets = [0, 1, 2].map((slot) => target([1, 0, 0], slot));

    targets.forEach((t) => {
      expect(poseGatedInstance(t, armed(m), ORIGIN, 0, 0, null)).toBe(true);
    });

    expect(animCounters.posed).toBe(3);
    expect(animCounters.skipped).toBe(0);
    expect(animCounters.bonesSolved).toBe(90);
  });
});
