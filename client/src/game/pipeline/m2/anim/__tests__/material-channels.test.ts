/** @jest-environment node */
import * as THREE from 'three';

import { InstanceAnim } from '../instance-anim';
import {
  channelCursor,
  channelTrackIndex,
  evaluateMaterialChannels,
  MaterialChannelValues,
} from '../material-channels';
import { ModelAnim } from '../model-anim';

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
  id: 0, subID: 0, length: 2000, flags: INLINE, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

/** Two sequence slots, so a test can prove the track is chosen by the PLAYING sequence. */
const model = (over: any = {}) => new ModelAnim({
  animations: [animation(), animation({ id: 1 })], sequences: [], bones: [], ...over,
});

const emptyBlock = () => ({ interpolationType: 1, globalSequenceID: -1, tracks: [] });

/** A block with one track per sequence slot. `tracks[i]` plays when sequence i is armed. */
const seqBlock = (tracks: any[], over: any = {}) => ({
  interpolationType: 1,
  globalSequenceID: -1,
  tracks: tracks.map((t, i) => ({ animationIndex: i, ...t })),
  ...over,
});

/** A global-sequence block: one track, and a cursor taken from world time. */
const globalBlock = (gseq: number, timestamps: number[], values: any[]) => ({
  interpolationType: 1,
  globalSequenceID: gseq,
  tracks: [{ animationIndex: 0, timestamps, values }],
});

const uvDef = (over: any = {}) => ({
  translation: emptyBlock(), rotation: emptyBlock(), scaling: emptyBlock(), ...over,
});

const colorDef = (over: any = {}) => ({ color: emptyBlock(), alpha: emptyBlock(), ...over });

const values = (uv = 0, transparency = 0, vertexColor = 0): MaterialChannelValues => ({
  uv: Array.from({ length: uv }, () => ({
    translation: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scaling: [1, 1, 1],
    matrix: new THREE.Matrix4(),
  })),
  transparency: Array.from({ length: transparency }, () => 1.0),
  vertexColor: Array.from({ length: vertexColor }, () => ({ color: [1, 1, 1], alpha: 1.0 })),
});

/** Where the composed UV matrix sends a texture coordinate. */
const mapUV = (matrix: THREE.Matrix4, u: number, v: number) =>
  new THREE.Vector3(u, v, 0).applyMatrix4(matrix);

describe('channelTrackIndex', () => {
  it('selects the playing sequence for a sequence-timeline block', () => {
    expect(channelTrackIndex(emptyBlock() as any, 3)).toBe(3);
  });

  /**
   * A global-sequence block carries ONE track and no sequence timeline. Indexing it by the playing
   * sequence finds nothing and freezes the channel -- a brazier that never pulses.
   */
  it('always selects track 0 for a global-sequence block', () => {
    expect(channelTrackIndex(globalBlock(0, [0], [1]) as any, 3)).toBe(0);
  });
});

describe('channelCursor', () => {
  it('reads a sequence channel from this placement own clock', () => {
    const m = model();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 1000);
    expect(channelCursor(m, emptyBlock() as any, inst, 1600)).toBe(600);
  });

  it('reads a global-sequence channel from world time, ignoring the instance', () => {
    const m = model({ sequences: [1000] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 900);
    // 2600 % 1000 = 600, with no reference at all to the 900ms arm time.
    expect(channelCursor(m, globalBlock(0, [0], [1]) as any, inst, 2600)).toBe(600);
  });

  it('still resolves a global-sequence channel for an instance that never armed', () => {
    const m = model({ sequences: [1000] });
    expect(channelCursor(m, globalBlock(0, [0], [1]) as any, null, 2600)).toBe(600);
  });
});

describe('UV animation', () => {
  it('samples translation on this placement clock', () => {
    const m = model();
    const defs = {
      uv: [uvDef({
        translation: seqBlock([{ timestamps: [0, 1000], values: [[0, 0, 0], [1, 0, 0]] }]),
      })],
      transparency: [],
      vertexColor: [],
    };
    const v = values(1);

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);

    evaluateMaterialChannels(m, inst, defs, v, 250);

    expect(v.uv[0].translation[0]).toBeCloseTo(0.25);
    // The pivot cancels for a pure translation: (0.5,0.5) -> +T -> back is just +T.
    const mapped = mapUV(v.uv[0].matrix, 0, 0);
    expect(mapped.x).toBeCloseTo(0.25);
    expect(mapped.y).toBeCloseTo(0);
  });

  /**
   * The whole reason this work is pushed per draw. Two placements of one model share a MATERIAL, so
   * if they did not hold their own sampled values, whichever one was evaluated last would win.
   */
  it('gives two placements armed at different times different values', () => {
    const m = model();
    const defs = {
      uv: [uvDef({
        translation: seqBlock([{ timestamps: [0, 1000], values: [[0, 0, 0], [1, 0, 0]] }]),
      })],
      transparency: [],
      vertexColor: [],
    };

    const early = new InstanceAnim(m);
    early.arm(m.sequences[0], 0);
    const late = new InstanceAnim(m);
    late.arm(m.sequences[0], 400);

    const earlyValues = values(1);
    const lateValues = values(1);
    evaluateMaterialChannels(m, early, defs, earlyValues, 800);
    evaluateMaterialChannels(m, late, defs, lateValues, 800);

    expect(earlyValues.uv[0].translation[0]).toBeCloseTo(0.8);
    expect(lateValues.uv[0].translation[0]).toBeCloseTo(0.4);
  });

  it('reads the track belonging to the sequence actually playing', () => {
    const m = model();
    const defs = {
      uv: [uvDef({
        translation: seqBlock([
          { timestamps: [0, 1000], values: [[0, 0, 0], [1, 0, 0]] },
          { timestamps: [0, 1000], values: [[0, 0, 0], [0, 1, 0]] },
        ]),
      })],
      transparency: [],
      vertexColor: [],
    };
    const v = values(1);

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[1], 0);
    evaluateMaterialChannels(m, inst, defs, v, 500);

    expect(v.uv[0].translation[0]).toBeCloseTo(0);
    expect(v.uv[0].translation[1]).toBeCloseTo(0.5);
  });

  /**
   * WoW composes the texture transform about the CENTRE of texture space
   * (WebWoWViewer `calcAnimMatrixes`). Without the pivot, a scale or a spin drags the texture toward
   * the corner instead of turning it in place.
   */
  it('scales about the texture centre, not the corner', () => {
    const m = model();
    const defs = {
      uv: [uvDef({ scaling: seqBlock([{ timestamps: [0], values: [[2, 2, 1]] }]) })],
      transparency: [],
      vertexColor: [],
    };
    const v = values(1);

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    evaluateMaterialChannels(m, inst, defs, v, 100);

    const centre = mapUV(v.uv[0].matrix, 0.5, 0.5);
    expect(centre.x).toBeCloseTo(0.5);
    expect(centre.y).toBeCloseTo(0.5);

    const corner = mapUV(v.uv[0].matrix, 1, 1);
    expect(corner.x).toBeCloseTo(1.5);
    expect(corner.y).toBeCloseTo(1.5);
  });

  it('rotates about the texture centre', () => {
    const m = model();
    // A quarter turn about the texture-space normal.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const defs = {
      uv: [uvDef({ rotation: seqBlock([{ timestamps: [0], values: [[q.x, q.y, q.z, q.w]] }]) })],
      transparency: [],
      vertexColor: [],
    };
    const v = values(1);

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    evaluateMaterialChannels(m, inst, defs, v, 100);

    const centre = mapUV(v.uv[0].matrix, 0.5, 0.5);
    expect(centre.x).toBeCloseTo(0.5);
    expect(centre.y).toBeCloseTo(0.5);

    // (1, 0.5) is half a unit right of centre; a quarter turn puts it half a unit above it.
    const right = mapUV(v.uv[0].matrix, 1, 0.5);
    expect(right.x).toBeCloseTo(0.5);
    expect(right.y).toBeCloseTo(1);
  });

  it('falls back to identity when the playing sequence drives nothing', () => {
    const m = model();
    const defs = {
      uv: [uvDef({
        translation: seqBlock([{ timestamps: [0, 1000], values: [[0, 0, 0], [1, 0, 0]] }]),
      })],
      transparency: [],
      vertexColor: [],
    };
    const v = values(1);

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    evaluateMaterialChannels(m, inst, defs, v, 500);
    expect(v.uv[0].translation[0]).toBeCloseTo(0.5);

    // Sequence 1 has no track on this block. The scroll must RESET, not hold at 0.5 forever.
    inst.arm(m.sequences[1], 500);
    evaluateMaterialChannels(m, inst, defs, v, 800);
    expect(v.uv[0].translation[0]).toBe(0);
    expect(v.uv[0].matrix.equals(new THREE.Matrix4())).toBe(true);
  });

  it('rewrites the same matrix object rather than allocating a new one', () => {
    const m = model();
    const defs = {
      uv: [uvDef({
        translation: seqBlock([{ timestamps: [0, 1000], values: [[0, 0, 0], [1, 0, 0]] }]),
      })],
      transparency: [],
      vertexColor: [],
    };
    const v = values(1);
    const matrix = v.uv[0].matrix;

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    evaluateMaterialChannels(m, inst, defs, v, 100);
    evaluateMaterialChannels(m, inst, defs, v, 200);

    expect(v.uv[0].matrix).toBe(matrix);
  });
});

describe('transparency', () => {
  it('samples the playing sequence track', () => {
    const m = model();
    const defs = {
      uv: [],
      transparency: [seqBlock([{ timestamps: [0, 1000], values: [1.0, 0.0] }])],
      vertexColor: [],
    };
    const v = values(0, 1);

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    evaluateMaterialChannels(m, inst, defs, v, 250);

    expect(v.transparency[0]).toBeCloseTo(0.75);
  });

  it('holds each key for a STEP block instead of interpolating', () => {
    const m = model();
    const defs = {
      uv: [],
      transparency: [seqBlock(
        [{ timestamps: [0, 1000], values: [1.0, 0.0] }],
        { interpolationType: 0 },
      )],
      vertexColor: [],
    };
    const v = values(0, 1);

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    evaluateMaterialChannels(m, inst, defs, v, 250);

    expect(v.transparency[0]).toBe(1.0);
  });

  /**
   * A global sequence is a pure function of world time, so every placement of the model must land on
   * the same value however long ago each one was armed. Reading it off the instance clock instead
   * makes a shared pulse drift per placement -- silently, and only visible as a courtyard of
   * braziers falling out of step over minutes.
   */
  it('holds a global-sequence channel identical across placements armed at different times', () => {
    const m = model({ sequences: [1000] });
    const defs = {
      uv: [],
      transparency: [globalBlock(0, [0, 1000], [1.0, 0.0])],
      vertexColor: [],
    };

    const early = new InstanceAnim(m);
    early.arm(m.sequences[0], 0);
    const late = new InstanceAnim(m);
    late.arm(m.sequences[0], 731);

    const earlyValues = values(0, 1);
    const lateValues = values(0, 1);
    // 5250 % 1000 = 250 for both. Sampled off the instance clock they would be 0.75 and 0.481.
    evaluateMaterialChannels(m, early, defs, earlyValues, 5250);
    evaluateMaterialChannels(m, late, defs, lateValues, 5250);

    expect(earlyValues.transparency[0]).toBeCloseTo(0.75);
    expect(lateValues.transparency[0]).toBe(earlyValues.transparency[0]);
  });

  it('resolves a global-sequence channel while the playing sequence is not slot 0', () => {
    const m = model({ sequences: [1000] });
    const defs = {
      uv: [],
      transparency: [globalBlock(0, [0, 1000], [1.0, 0.0])],
      vertexColor: [],
    };
    const v = values(0, 1);

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[1], 0);
    evaluateMaterialChannels(m, inst, defs, v, 500);

    expect(v.transparency[0]).toBeCloseTo(0.5);
  });

  /**
   * Two-phase on purpose. Asserting 1.0 straight after construction would also pass against a
   * version that simply left the slot alone, since `values()` seeds it at 1.0 -- so drive it away
   * from the default first, then prove the fallback RESETS it.
   */
  it('falls back to fully opaque when the playing sequence drives nothing', () => {
    const m = model();
    const defs = {
      uv: [],
      transparency: [seqBlock([{ timestamps: [0, 1000], values: [1.0, 0.0] }])],
      vertexColor: [],
    };
    const v = values(0, 1);

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    evaluateMaterialChannels(m, inst, defs, v, 250);
    expect(v.transparency[0]).toBeCloseTo(0.75);

    // Sequence 1 has no track on this block. The batch must go back to fully opaque, not hold 0.75.
    inst.arm(m.sequences[1], 250);
    evaluateMaterialChannels(m, inst, defs, v, 600);
    expect(v.transparency[0]).toBe(1.0);
  });
});

describe('vertex colour', () => {
  it('samples colour and alpha independently', () => {
    const m = model();
    const defs = {
      uv: [],
      transparency: [],
      vertexColor: [colorDef({
        color: seqBlock([{ timestamps: [0, 1000], values: [[1, 0, 0], [0, 0, 1]] }]),
        alpha: seqBlock([{ timestamps: [0, 1000], values: [1.0, 0.0] }]),
      })],
    };
    const v = values(0, 0, 1);

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    evaluateMaterialChannels(m, inst, defs, v, 500);

    expect(v.vertexColor[0].color[0]).toBeCloseTo(0.5);
    expect(v.vertexColor[0].color[1]).toBeCloseTo(0);
    expect(v.vertexColor[0].color[2]).toBeCloseTo(0.5);
    expect(v.vertexColor[0].alpha).toBeCloseTo(0.5);
  });

  it('falls back to white and opaque when the playing sequence drives nothing', () => {
    const m = model();
    const defs = {
      uv: [],
      transparency: [],
      vertexColor: [colorDef({
        color: seqBlock([{ timestamps: [0, 1000], values: [[1, 0, 0], [0, 0, 1]] }]),
        alpha: seqBlock([{ timestamps: [0, 1000], values: [1.0, 0.0] }]),
      })],
    };
    const v = values(0, 0, 1);

    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    evaluateMaterialChannels(m, inst, defs, v, 500);
    expect(v.vertexColor[0].alpha).toBeCloseTo(0.5);

    inst.arm(m.sequences[1], 500);
    evaluateMaterialChannels(m, inst, defs, v, 800);
    expect(v.vertexColor[0].color).toEqual([1, 1, 1]);
    expect(v.vertexColor[0].alpha).toBe(1.0);
  });
});

describe('degenerate input', () => {
  it('does nothing for a model with no channels at all', () => {
    const m = model();
    const v = values();
    expect(() => evaluateMaterialChannels(
      m, null, { uv: [], transparency: [], vertexColor: [] }, v, 1000,
    )).not.toThrow();
  });

  it('skips a def with no matching value slot instead of throwing', () => {
    const m = model();
    const defs = {
      uv: [uvDef({ translation: seqBlock([{ timestamps: [0], values: [[1, 0, 0]] }]) })],
      transparency: [],
      vertexColor: [colorDef()],
    };
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);

    expect(() => evaluateMaterialChannels(m, inst, defs, values(), 100)).not.toThrow();
  });
});

/**
 * Nothing upstream checks `inst.current` before evaluating. The material path is reached with a
 * null instance (`evaluateMaterialChannels(m, null, ...)`) and with an instance that was allocated
 * from `animated` but never armed -- e.g. a unit whose `resolve` returned null because every
 * sequence it owns is external, or a doodad whose `armDoodad` latched unarmable.
 *
 * Defaulting that case to slot 0 samples a real sequence's track, and slot 0 is not guaranteed
 * inline. `UNARMED_SLOT` is -1, a non-slot, so every sequence-timeline channel holds its identity.
 */
describe('the unarmed instance reads a non-slot, not slot 0', () => {
  const quarantinedSlotZero = () => new ModelAnim({
    // Slot 0 EXTERNAL, slot 1 inline: the shape that makes the old `: 0` default sample noise.
    animations: [animation({ id: 0, flags: 0 }), animation({ id: 1, flags: INLINE })],
    sequences: [],
    bones: [],
  });

  // Kills: `inst && inst.current ? ... : 0`. Slot 0's track is loud and non-identity, so a default
  // of 0 writes 0.25 here instead of leaving the channel opaque.
  it('holds transparency at its identity rather than sampling slot 0', () => {
    const m = quarantinedSlotZero();
    const defs = {
      uv: [],
      transparency: [seqBlock([
        { timestamps: [0, 1000], values: [0.0, 0.5] },   // slot 0 -- quarantined noise
        { timestamps: [0, 1000], values: [1.0, 1.0] },   // slot 1 -- inline
      ])],
      vertexColor: [],
    };
    const v = values(0, 1, 0);

    const neverArmed = new InstanceAnim(m);
    expect(neverArmed.current).toBeNull();
    evaluateMaterialChannels(m, neverArmed, defs, v, 500);
    expect(v.transparency[0]).toBe(1.0);

    // Same for no instance at all, which is the other way this path is reached.
    v.transparency[0] = 1.0;
    evaluateMaterialChannels(m, null, defs, v, 500);
    expect(v.transparency[0]).toBe(1.0);
  });

  // Kills: over-correcting the fix into "an unarmed instance evaluates nothing". A global sequence
  // is clock-driven with zero arming -- `channelTrackIndex` overrides the slot with 0 for those --
  // so a brazier must keep pulsing on an instance nobody ever armed.
  it('still runs a global-sequence channel while unarmed', () => {
    const m = new ModelAnim({
      animations: [animation({ id: 0, flags: 0 })],
      sequences: [1000],
      bones: [],
    });
    const defs = {
      uv: [],
      transparency: [globalBlock(0, [0, 1000], [0.0, 1.0])],
      vertexColor: [],
    };
    const v = values(0, 1, 0);

    evaluateMaterialChannels(m, new InstanceAnim(m), defs, v, 500);
    expect(v.transparency[0]).toBeCloseTo(0.5);
  });
});
