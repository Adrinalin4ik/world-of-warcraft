/** @jest-environment node */
import { classify, ModelAnim, sequenceLoops } from '../model-anim';

const emptyBlock = () => ({ interpolationType: 1, globalSequenceID: -1, tracks: [], animated: false });
const keyedBlock = () => ({
  interpolationType: 1,
  globalSequenceID: -1,
  tracks: [{ animationIndex: 0, timestamps: [0, 100], values: [[0, 0, 0], [1, 1, 1]] }],
  animated: true,
});

const bone = (over: any = {}) => ({
  parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
  translation: emptyBlock(), rotation: emptyBlock(), scaling: emptyBlock(),
  ...over,
});

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: 0, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0,
  ...over,
});

const data = (over: any = {}) => ({
  animations: [animation()], sequences: [], bones: [bone()], ...over,
});

describe('sequenceLoops', () => {
  it('loops when bit 0 is clear', () => {
    expect(sequenceLoops(0)).toBe(true);
    expect(sequenceLoops(0x20)).toBe(true);
  });

  it('is one-shot when bit 0 is set', () => {
    expect(sequenceLoops(0x01)).toBe(false);
    expect(sequenceLoops(0x21)).toBe(false);
  });
});

describe('classify', () => {
  it('is false for a model with no animated channel', () => {
    expect(classify(data())).toBe(false);
  });

  it('is true when a bone has any animated channel', () => {
    expect(classify(data({ bones: [bone({ rotation: keyedBlock() })] }))).toBe(true);
  });

  it('is true for a model animated only through UV', () => {
    expect(classify(data({ uvAnimations: [{ translation: keyedBlock() }] }))).toBe(true);
  });

  it('is true for a model animated only through transparency', () => {
    expect(classify(data({ transparencyAnimations: [keyedBlock()] }))).toBe(true);
  });

  it('is true for a model animated only through vertex-colour color', () => {
    expect(classify(data({ vertexColorAnimations: [{ color: keyedBlock(), alpha: emptyBlock() }] }))).toBe(true);
  });

  it('is true for a model animated only through vertex-colour alpha', () => {
    expect(classify(data({ vertexColorAnimations: [{ color: emptyBlock(), alpha: keyedBlock() }] }))).toBe(true);
  });
});

describe('ModelAnim', () => {
  it('builds a sequence table off the parsed animation structs', () => {
    const m = new ModelAnim(data({
      animations: [animation({ id: 0, length: 1200, blendTime: 150, flags: 0 })],
    }));
    expect(m.sequences).toHaveLength(1);
    expect(m.sequences[0]).toMatchObject({
      index: 0, id: 0, lengthMs: 1200, blendTimeMs: 150, loops: true,
    });
  });

  it('marks a bit-0 sequence as one-shot', () => {
    const m = new ModelAnim(data({ animations: [animation({ flags: 0x01 })] }));
    expect(m.sequences[0].loops).toBe(false);
  });

  it('carries the global sequence duration table', () => {
    const m = new ModelAnim(data({ sequences: [500, 0, 1500] }));
    expect(m.globalSequenceDurations).toEqual([500, 0, 1500]);
  });

  it('reports animated for a model with keyed bones', () => {
    expect(new ModelAnim(data({ bones: [bone({ rotation: keyedBlock() })] })).animated).toBe(true);
    expect(new ModelAnim(data()).animated).toBe(false);
  });
});
