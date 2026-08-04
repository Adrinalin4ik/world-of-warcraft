/** @jest-environment node */
import { classify, hasInlineData, ModelAnim, sequenceLoops } from '../model-anim';

/**
 * The inline-data bit every fixture sequence carries unless it is testing the quarantine.
 *
 * `0x20` is what wolf.m2's Stand/Walk/Run actually hold. The old fixtures used `flags: 0`, which
 * real data only ever shows on an EXTERNAL sequence -- they were describing a model that cannot
 * exist. `0x20` leaves `sequenceLoops` (bit 0) untouched, so no clock law moves.
 */
const INLINE = 0x20;

const emptyBlock = () => ({ interpolationType: 1, globalSequenceID: -1, tracks: [], animated: false });
const keyedBlock = () => ({
  interpolationType: 1,
  globalSequenceID: -1,
  tracks: [{ animationIndex: 0, timestamps: [0, 100], values: [[0, 0, 0], [1, 1, 1]] }],
  animated: true,
});

/** A block holding exactly one key, of whatever value the caller names. */
const singleKeyBlock = (value: any) => ({
  interpolationType: 1,
  globalSequenceID: -1,
  tracks: [{ animationIndex: 0, timestamps: [0], values: [value] }],
  animated: true,
});

const bone = (over: any = {}) => ({
  parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
  translation: emptyBlock(), rotation: emptyBlock(), scaling: emptyBlock(),
  ...over,
});

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: INLINE, probability: 32767,
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

  // A single key equal to the channel's identity is the default written out as a keyframe, not
  // animation. The parser applies this rule to transparency
  // (`wow-data-parser/m2/index.js:196-204`) and `classify()` has to agree, or mass-placed static
  // models join the per-frame posing set for a guaranteed no-op. Measured on
  // `world_generic_passivedoodads_particleemitters_bubblesb.m2` and `..._lavasplashparticle.m2`,
  // both of which are `canInstance` and carry exactly one transparency key of 1.0.
  describe('the lone-identity-key rule', () => {
    it('rejects a single fully-opaque transparency key', () => {
      expect(classify(data({ transparencyAnimations: [singleKeyBlock(1.0)] }))).toBe(false);
    });

    it('accepts a single transparency key that is NOT fully opaque', () => {
      expect(classify(data({ transparencyAnimations: [singleKeyBlock(0.5)] }))).toBe(true);
    });

    it('accepts two transparency keys even when both are fully opaque', () => {
      const twoOpaque = {
        interpolationType: 1, globalSequenceID: -1, animated: true,
        tracks: [{ animationIndex: 0, timestamps: [0, 100], values: [1.0, 1.0] }],
      };
      expect(classify(data({ transparencyAnimations: [twoOpaque] }))).toBe(true);
    });

    it('counts keys ACROSS sequence tracks, not per track', () => {
      const oneKeyEachInTwoSequences = {
        interpolationType: 1, globalSequenceID: -1, animated: true,
        tracks: [
          { animationIndex: 0, timestamps: [0], values: [1.0] },
          { animationIndex: 1, timestamps: [0], values: [1.0] },
        ],
      };
      // BOTH slots must exist and be inline, or the quarantine drops the second key and the
      // lone-identity-key rule -- correctly -- calls this static.
      expect(classify(data({
        animations: [animation(), animation({ id: 1 })],
        transparencyAnimations: [oneKeyEachInTwoSequences],
      }))).toBe(true);
    });

    it('rejects a single white vertex-colour key', () => {
      expect(classify(data({
        vertexColorAnimations: [{ color: singleKeyBlock([1.0, 1.0, 1.0]), alpha: emptyBlock() }],
      }))).toBe(false);
    });

    it('accepts a single NON-white vertex-colour key', () => {
      expect(classify(data({
        vertexColorAnimations: [{ color: singleKeyBlock([1.0, 0.0, 0.0]), alpha: emptyBlock() }],
      }))).toBe(true);
    });

    it('rejects a single fully-opaque vertex-colour alpha key', () => {
      expect(classify(data({
        vertexColorAnimations: [{ color: emptyBlock(), alpha: singleKeyBlock(1.0) }],
      }))).toBe(false);
    });

    it('treats a malformed key with no value as animated, matching the parser', () => {
      const noValue = {
        interpolationType: 1, globalSequenceID: -1, animated: true,
        tracks: [{ animationIndex: 0, timestamps: [0], values: [] }],
      };
      expect(classify(data({ transparencyAnimations: [noValue] }))).toBe(true);
    });

    it('does NOT apply to bones -- a lone bone key is still animation', () => {
      expect(classify(data({
        bones: [bone({ translation: singleKeyBlock([0, 0, 0]) })],
      }))).toBe(true);
    });
  });
});

describe('ModelAnim', () => {
  it('builds a sequence table off the parsed animation structs', () => {
    const m = new ModelAnim(data({
      animations: [animation({ id: 0, length: 1200, blendTime: 150, flags: INLINE })],
    }));
    expect(m.sequences).toHaveLength(1);
    expect(m.sequences[0]).toMatchObject({
      index: 0, id: 0, lengthMs: 1200, blendTimeMs: 150, loops: true,
    });
  });

  it('marks a bit-0 sequence as one-shot', () => {
    const m = new ModelAnim(data({ animations: [animation({ flags: INLINE | 0x01 })] }));
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
        animation({ id: 0, flags: INLINE }),
        animation({ id: 9, flags: INLINE | 0x40, alias: 0 }),
      ],
    }));
    expect(m.resolve(9)!.id).toBe(0);
  });

  it('does not hang on an alias cycle', () => {
    const m = new ModelAnim(data({
      animations: [
        animation({ id: 1, flags: INLINE | 0x40, alias: 1 }),
        animation({ id: 2, flags: INLINE | 0x40, alias: 0 }),
      ],
    }));
    expect(() => m.resolve(1)).not.toThrow();
  });

  it('returns null for a model with no sequences at all', () => {
    expect(new ModelAnim(data({ animations: [] })).resolve(0)).toBeNull();
  });
});

describe('hasInlineData', () => {
  // Kills: an empty / wrong mask. 0x130 is the bit set WoWModelViewer and the old AnimationManager
  // both test, and the values below are what wolf.m2 and kobold.m2 actually carry.
  it('is true when any of 0x10 / 0x20 / 0x100 is set', () => {
    expect(hasInlineData(0x20)).toBe(true);   // wolf Stand id 0, Walk id 4, Run id 5
    expect(hasInlineData(0x21)).toBe(true);
    expect(hasInlineData(0x23)).toBe(true);
    expect(hasInlineData(0x61)).toBe(true);   // an ALIAS that still carries its own inline bit
    expect(hasInlineData(0x10)).toBe(true);
    expect(hasInlineData(0x100)).toBe(true);
  });

  // Kills: widening the mask to catch a low bit. 0x40 (alias) in particular must NOT be in it --
  // `resolve` relies on alias-ness and inline-ness being separate questions.
  it('is false for the external flag values observed in real data', () => {
    // wolf ids 96-101 and 69/128, kobold id 62 -- measured, not invented.
    [0, 1, 3, 5, 8].forEach((f) => expect(hasInlineData(f)).toBe(false));
    expect(hasInlineData(0x40)).toBe(false);
  });
});

describe('external sequences are quarantined', () => {
  const seqs = () => [
    animation({ id: 0, flags: INLINE }),
    animation({ id: 97, flags: 0 }),
  ];

  // Kills: dropping `inline` from the table, or hard-coding it true. Also pins that the external
  // entry SURVIVES at its own file slot -- Task 20 needs the row, and `index` is the track index.
  it('marks each sequence with whether its data is inline, keeping both rows', () => {
    const m = new ModelAnim(data({ animations: seqs() }));
    expect(m.sequences.map((s) => s.inline)).toEqual([true, false]);
    expect(m.sequences.map((s) => s.index)).toEqual([0, 1]);
    expect(m.sequences[1].id).toBe(97);
  });

  // Kills: removing the `.inline` filter from `variationsOf`.
  it('never lists an external variation', () => {
    const m = new ModelAnim(data({
      animations: [
        animation({ id: 4, subID: 0, flags: 0 }),
        animation({ id: 4, subID: 1, flags: INLINE }),
      ],
    }));
    expect(m.variationsOf(4).map((s) => s.subId)).toEqual([1]);
  });

  // Kills: filtering `variationsOf` but letting `pickVariation` reach `roll % length` on an empty
  // list (NaN index -> undefined, not null), and kills dropping the filter entirely.
  it('never picks an external variation, and does not divide by zero doing it', () => {
    const m = new ModelAnim(data({
      animations: [animation({ id: 0, subID: 0, flags: 0, probability: 32767 })],
    }));
    expect(m.pickVariation(0, 0)).toBeNull();
    // Zero total weight is the branch that does the modulo; it must still be unreachable.
    const zeroWeight = new ModelAnim(data({
      animations: [animation({ id: 0, subID: 0, flags: 0, probability: 0 })],
    }));
    expect(zeroWeight.pickVariation(0, 12345)).toBeNull();
  });

  // Kills: `resolve` returning the external entry it found for the requested id.
  it('resolve falls back rather than returning an external sequence', () => {
    const m = new ModelAnim(data({ animations: seqs() }));
    const got = m.resolve(97)!;
    expect(got).not.toBeNull();
    expect(got.inline).toBe(true);
    expect(got.id).toBe(0);
  });

  // Kills: keeping `return current || this.sequences[0]`. Slot 0 here is EXTERNAL, so the old
  // fallback hands back exactly the noise the quarantine exists to withhold.
  it('resolve falls back to the first INLINE sequence, not to sequence 0', () => {
    const m = new ModelAnim(data({
      animations: [
        animation({ id: 0, flags: 0 }),
        animation({ id: 4, flags: INLINE }),
      ],
    }));
    expect(m.resolve(999)!.id).toBe(4);
  });

  // Kills: an exit gate that never returns null. A model whose every sequence is external has
  // nothing safe to play, and posing it from slot 0 is the original bug.
  it('resolve returns null when the model has no inline sequence at all', () => {
    const m = new ModelAnim(data({ animations: [animation({ id: 0, flags: 0 })] }));
    expect(m.resolve(0)).toBeNull();
  });

  // Kills: gating only at lookup. `sequences[current.alias]` is a raw slot index, so an inline
  // alias walks straight into a quarantined target unless the gate sits at the exit.
  it('does not follow an alias into a quarantined target', () => {
    const m = new ModelAnim(data({
      animations: [
        animation({ id: 0, flags: INLINE }),
        animation({ id: 97, flags: 0 }),
        animation({ id: 9, flags: INLINE | 0x40, alias: 1 }),
      ],
    }));
    expect(m.resolve(9)!.id).toBe(0);
  });

  // Kills: `findById` returning the first id match unconditionally. The external row comes first in
  // file order, and collapsing to Stand would lose a variation the model really can play.
  it('prefers an inline sibling over an external entry sharing the id', () => {
    const m = new ModelAnim(data({
      animations: [
        animation({ id: 0, flags: INLINE }),
        animation({ id: 5, subID: 0, flags: 0 }),
        animation({ id: 5, subID: 1, flags: INLINE }),
      ],
    }));
    const got = m.resolve(5)!;
    expect(got.id).toBe(5);
    expect(got.subId).toBe(1);
  });

  const externalKeysOnly = () => bone({
    rotation: {
      interpolationType: 1,
      globalSequenceID: -1,
      tracks: [
        { animationIndex: 0, timestamps: [], values: [] },
        { animationIndex: 1, timestamps: [0, 999999999], values: [[0, 0, 0, 1], [0, 0, 0, 1]] },
      ],
    },
  });

  // Kills: leaving `blockAnimated` slot-blind. This is the 302-track case on wolf.m2 -- get it
  // permissive and every external-heavy creature flips to animated and poses from garbage.
  it('classify ignores keys that live in an external slot', () => {
    expect(classify(data({ animations: seqs(), bones: [externalKeysOnly()] }))).toBe(false);
  });

  // Kills: over-correcting into "ignore slot 1 always". Same block, same keys -- only the owning
  // sequence's flags differ, and now it must be animated.
  it('counts those same keys once their slot is inline', () => {
    expect(classify(data({
      animations: [animation({ id: 0, flags: INLINE }), animation({ id: 97, flags: INLINE })],
      bones: [externalKeysOnly()],
    }))).toBe(true);
  });

  // Kills: applying the slot filter to a GLOBAL-SEQUENCE block. Its tracks array is not a sequence
  // timeline -- track 0 is read whatever is playing -- so filtering it freezes every clock-driven
  // glow in the game.
  it('classify still counts a global-sequence block whose slot is external', () => {
    const globalBlock = {
      interpolationType: 1,
      globalSequenceID: 0,
      tracks: [{ animationIndex: 0, timestamps: [0, 500], values: [0.0, 1.0] }],
    };
    expect(classify({
      animations: [animation({ id: 0, flags: 0 })],
      sequences: [1000],
      bones: [],
      transparencyAnimations: [globalBlock],
    })).toBe(true);
  });

  // Kills: folding the inline bit into `sequenceLoops`. Bit 0 is independent of the 0x130 mask, and
  // an external one-shot must still report one-shot -- Task 20 lifts the quarantine without
  // re-deriving the clock law.
  it('leaves the loop law independent of the inline bit', () => {
    expect(sequenceLoops(0x00)).toBe(sequenceLoops(0x20));
    expect(sequenceLoops(0x01)).toBe(sequenceLoops(0x21));
    const m = new ModelAnim(data({ animations: [animation({ id: 0, flags: 0x01 })] }));
    expect(m.sequences[0]).toMatchObject({ inline: false, loops: false });
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

