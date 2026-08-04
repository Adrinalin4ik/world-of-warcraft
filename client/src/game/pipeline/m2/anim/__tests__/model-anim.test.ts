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

describe('pickVariation', () => {
  const m = new ModelAnim(data({
    animations: [
      animation({ id: 0, subID: 0, probability: 30000 }),
      animation({ id: 0, subID: 1, probability: 2767 }),
      animation({ id: 4, subID: 0, probability: 32767 }),
    ],
  }));

  it('lists every variation sharing an id', () => {
    expect(m.variationsOf(0).map((s) => s.subId)).toEqual([0, 1]);
    expect(m.variationsOf(4).map((s) => s.subId)).toEqual([0]);
  });

  it('selects by cumulative probability weight', () => {
    expect(m.pickVariation(0, 0)!.subId).toBe(0);
    expect(m.pickVariation(0, 29999)!.subId).toBe(0);
    expect(m.pickVariation(0, 30000)!.subId).toBe(1);
    expect(m.pickVariation(0, 32766)!.subId).toBe(1);
  });

  it('clamps a roll at or past the total weight to the last variation', () => {
    expect(m.pickVariation(0, 999999)!.subId).toBe(1);
  });

  it('returns null for an id the model does not own', () => {
    expect(m.pickVariation(77, 0)).toBeNull();
  });

  it('returns the only variation regardless of roll when weights are all zero', () => {
    const zero = new ModelAnim(data({
      animations: [animation({ id: 2, subID: 0, probability: 0 }),
                   animation({ id: 2, subID: 1, probability: 0 })],
    }));
    expect(zero.pickVariation(2, 12345)).not.toBeNull();
  });
});

describe('resolve', () => {
  it('returns a directly owned sequence', () => {
    const m = new ModelAnim(data({ animations: [animation({ id: 5 })] }));
    expect(m.resolve(5)!.id).toBe(5);
  });

  it('falls back to sequence 0 when the requested id is absent', () => {
    const m = new ModelAnim(data({
      animations: [animation({ id: 0, nextAnimationID: -1 })],
    }));
    // 5 is absent; nothing chains to it, so it falls back to Stand (id 0).
    expect(m.resolve(5)!.id).toBe(0);
  });

  it('follows an alias to its target', () => {
    const m = new ModelAnim(data({
      animations: [
        animation({ id: 0, flags: 0 }),
        animation({ id: 9, flags: 0x40, alias: 0 }),
      ],
    }));
    expect(m.resolve(9)!.id).toBe(0);
  });

  it('does not hang on an alias cycle', () => {
    const m = new ModelAnim(data({
      animations: [
        animation({ id: 1, flags: 0x40, alias: 1 }),
        animation({ id: 2, flags: 0x40, alias: 0 }),
      ],
    }));
    expect(() => m.resolve(1)).not.toThrow();
  });

  it('returns null for a model with no sequences at all', () => {
    expect(new ModelAnim(data({ animations: [] })).resolve(0)).toBeNull();
  });
});

describe('globalSequenceCursor', () => {
  const m = new ModelAnim(data({ sequences: [1000, 0, 250] }));

  it('wraps world time on the sequence duration', () => {
    expect(m.globalSequenceCursor(0, 2500)).toBe(500);
    expect(m.globalSequenceCursor(2, 600)).toBe(100);
  });

  it('is identical for every caller at the same world time -- there is no per-instance state', () => {
    const other = new ModelAnim(data({ sequences: [1000, 0, 250] }));
    expect(other.globalSequenceCursor(0, 12345)).toBe(m.globalSequenceCursor(0, 12345));
  });

  it('returns 0 for a zero-duration global sequence', () => {
    expect(m.globalSequenceCursor(1, 9999)).toBe(0);
  });

  it('returns 0 for an out-of-range index', () => {
    expect(m.globalSequenceCursor(9, 9999)).toBe(0);
  });
});

