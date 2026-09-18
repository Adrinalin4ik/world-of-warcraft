import {
  kitEmitters, KIT_SLOT_TAGS, WORLD_EFFECT_TAG, WORLD_SLOT, UNTAGGED_SLOTS,
} from '../spell-kit-fx';

/**
 * WHICH LAYER THIS COVERS: the slot -> tag mapping and the refusal, over a stubbed `spellData`. It is
 * authoritative for "does slot 2 resolve to 0x13 and does slot 6 resolve to nothing".
 *
 * It is authoritative for NOTHING about whether those tags are the right bones -- that is measured
 * against 23 real served models by `harness/attach-probe.test.js`, and against
 * `SpellVisualKitModelAttach.dbc` alongside it. A unit test here that asserted `0x13 === 0x13` would
 * be the self-consistency trap.
 */
const slots: Array<number | null> = [
  101, // 0  head
  null, // 1  chest
  103, // 2  base
  null, // 3
  null, // 4
  null, // 5
  777, // 6  weapon A -- untagged on this build
  778, // 7  weapon B -- untagged on this build
  109, // 8  special1
  null, // 9
  null, // 10
];

jest.mock('../../pipeline/dbc/spell-data', () => ({
  spellData: {
    kitEffectSlots: (kit: number) => (kit === 38 ? slots : null),
    kitWorldEffect: (kit: number) => (kit === 38 ? 284 : null),
    // 777 and 778 would resolve if they were ever asked for -- the point of the test is that they
    // are not, because the slot is refused before the path lookup.
    effectModelPath: (id: number) => `Spells\\Effect_${id}.mdx`,
  },
}));

describe('kitEmitters', () => {
  it('places the tagged slots, refuses the two untagged ones, and puts the world plant last', () => {
    const emitters = kitEmitters(38);

    expect(emitters).toEqual([
      { slot: 0, tag: 0x14, effectId: 101, modelPath: 'Spells\\Effect_101.mdx' },
      { slot: 2, tag: 0x13, effectId: 103, modelPath: 'Spells\\Effect_103.mdx' },
      { slot: 8, tag: 0x17, effectId: 109, modelPath: 'Spells\\Effect_109.mdx' },
      {
        slot: WORLD_SLOT, tag: WORLD_EFFECT_TAG, effectId: 284, modelPath: 'Spells\\Effect_284.mdx',
      },
    ]);

    // THE REFUSAL IS THE POINT. Effects 777 and 778 sit in slots 6 and 7, whose attachment tags this
    // build does not establish, and `effectModelPath` would happily have returned a path for both --
    // so a slot that leaked through would appear here with a guessed tag rather than be absent.
    expect(emitters.map((e) => e.effectId)).not.toContain(777);
    expect(emitters.map((e) => e.effectId)).not.toContain(778);
    expect(UNTAGGED_SLOTS).toEqual([6, 7]);
    for (const slot of UNTAGGED_SLOTS) {
      expect(KIT_SLOT_TAGS[slot]).toBeNull();
    }

    // Eleven slots, not the reference's nine.
    expect(KIT_SLOT_TAGS).toHaveLength(11);
  });
});
