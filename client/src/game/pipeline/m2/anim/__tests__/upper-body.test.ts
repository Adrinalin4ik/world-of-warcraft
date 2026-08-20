/** @jest-environment node */
import * as THREE from 'three';
import { InstanceAnim } from '../instance-anim';
import { ModelAnim } from '../model-anim';
import { upperBodyMask, upperSubtreeRoot } from '../upper-body';

/** `0x20` = keyframes inline in this .m2 -- see `instance-anim.test.ts` for why not `0`. */
const INLINE = 0x20;

const emptyBlock = () => ({ interpolationType: 1, globalSequenceID: -1, tracks: [] });
const bone = (over: any = {}) => ({
  parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
  translation: emptyBlock(), rotation: emptyBlock(), scaling: emptyBlock(), ...over,
});

/**
 * The shape of `humanmale.m2`'s split, measured off the real file (see `upper-body.ts`): bone 0 is
 * the model root, bone 1 carries KeyBoneID 26 (Root), and its two children are bone 2 (KeyBoneID 4,
 * SpineLow -- the split root) and bone 3 (KeyBoneID 5, Waist), with the legs under the Waist.
 *
 * Bone 4 stands in for an arm (under SpineLow) and bone 5 for a thigh (under the Waist).
 */
const SPLIT_RIG = [
  bone(),
  bone({ parentID: 0, keyBoneID: 26 }),
  bone({ parentID: 1, keyBoneID: 4 }),
  bone({ parentID: 1, keyBoneID: 5 }),
  bone({ parentID: 2 }),
  bone({ parentID: 3 }),
];

describe('the upper-body split', () => {
  it('roots on KeyBoneID 4 and puts the arm in, the waist and the leg out', () => {
    expect(upperSubtreeRoot(SPLIT_RIG)).toBe(2);
    expect(Array.from(upperBodyMask(SPLIT_RIG)!)).toEqual([0, 0, 1, 0, 1, 0]);
    // The client's `-1` sentinel: a rig with no split key-bone has no mask, and the caller must then
    // route the one-shot full body rather than mask it to nothing.
    expect(upperSubtreeRoot([bone(), bone({ parentID: 0 })])).toBe(-1);
    expect(upperBodyMask([bone(), bone({ parentID: 0 })])).toBeNull();
  });
});

describe('a masked overlay', () => {
  it('drives the arm while the leg keeps the base clip', () => {
    // Two sequences, both one-shots so their windows clamp rather than wrap. Slot 0 is the "gait":
    // it moves EVERY bone by +10 on x. Slot 1 is the "swing": it moves every bone by +4 on y.
    // Masked, only the arm may show the swing, and the leg must be untouched by it.
    const m = new ModelAnim({
      animations: [
        {
          id: 5, subID: 0, length: 2000, flags: INLINE | 0x01, probability: 32767,
          blendTime: 0, movementSpeed: 0, nextAnimationID: -1, alias: 0,
        },
        {
          id: 17, subID: 0, length: 2000, flags: INLINE | 0x01, probability: 32767,
          blendTime: 0, movementSpeed: 0, nextAnimationID: -1, alias: 0,
        },
      ],
      sequences: [],
      bones: SPLIT_RIG.map((b) => ({
        ...b,
        // `trackFor` indexes `tracks` by FILE SLOT, so track 0 is the gait and track 1 the swing.
        translation: {
          interpolationType: 1,
          globalSequenceID: -1,
          tracks: [
            { animationIndex: 0, timestamps: [0, 1000], values: [[0, 0, 0], [10, 0, 0]] },
            { animationIndex: 1, timestamps: [0, 1000], values: [[0, 0, 0], [0, 4, 0]] },
          ],
        },
      })),
    });

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.armOverlay(m.sequences[1], m.upperBodyMask()!, 0);
    inst.solveBones(1000);

    const at = (i: number) => new THREE.Vector3()
      .setFromMatrixPosition(new THREE.Matrix4().fromArray(inst.palette, i * 16));

    // The ARM (bone 4) and the SpineLow root (bone 2) are both inside the split, so both show the
    // swing and neither shows the gait: 2 x 4 on y. Bones 0 and 1 are OUTSIDE it, so the arm still
    // inherits their 2 x 10 on x -- masking the torso does not detach it from the body.
    expect(at(4).x).toBeCloseTo(20, 4);
    expect(at(4).y).toBeCloseTo(8, 4);
    // The LEG (bone 5, outside): the base clip only, composed through the unmasked waist.
    expect(at(5).x).toBeCloseTo(40, 4);
    expect(at(5).y).toBeCloseTo(0, 4);
  });
});
