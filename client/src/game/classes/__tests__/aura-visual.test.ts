import { AuraStateKits } from '../aura-visual';

/**
 * The aura state kit's ARM and REAP edges -- the mechanism the owner's missing buff visual needed.
 *
 * Both collaborators are mocked because both are already measured elsewhere and neither is what this
 * asserts: `spellData.stateKit` is pinned by the real served records in
 * `wow-data-parser/dbc/entities/__tests__/spell-visual.test.js` (Mana Shield 1463 -> visual 968 ->
 * kit 990), and `kitEmitters` by the 23-model attach probe. What is unproven and worth a test is the
 * DIFF: that a spell id appearing in the slots arms exactly once and stays armed across a refresh,
 * and that leaving the slots reaps it.
 *
 * **WHICH LAYER THIS COVERS**, per `CLAUDE.md`'s rule about not generalising a green result: this is
 * the pure diff and nothing else. No world, no packets, no scene, no models. It says nothing about
 * whether a model spawns, parents or draws -- that is `world/spell-kit-effects.ts`' own suite and,
 * for the pixels, the owner's eye.
 */

jest.mock('../../pipeline/dbc/spell-data', () => ({
  spellData: {
    // Mana Shield's real chain; every other spell has no state kit, which is the common case
    // (Frost Ward, Fire Ward and every Armor spell measure `stateKitID = 0`).
    stateKit: (spellId: number) => (spellId === 1463 ? 990 : null),
  },
}));

jest.mock('../spell-kit-fx', () => ({
  // Kit 990's single base-slot emitter: effect 718 -> `Spells\ManaShield_State_Base.mdx` at tag 0x13.
  kitEmitters: (kitId: number) => (kitId === 990
    ? [{ slot: 2, tag: 0x13, effectId: 718, modelPath: 'Spells\\ManaShield_State_Base.mdx' }]
    : []),
}));

jest.mock('../../ui/framexml/lua/methods/region', () => ({ warnOnce: () => undefined }));

const GUID = '0x0000000000000001';

test('a state-kit aura arms once, survives a refresh, and reaps when it leaves the slots', () => {
  const kits = new AuraStateKits();

  // The buff lands. One arm, carrying the kit the DBC chain resolved.
  const applied = kits.diff(GUID, [1463]);
  expect(applied.begin).toEqual([{ spellId: 1463, kitId: 990 }]);
  expect(applied.reap).toEqual([]);

  // A REFRESH re-states the same slot with no edge at all -- the aura never left, so re-arming would
  // restart the model's birth. This is the case that makes the armed set necessary.
  const refreshed = kits.diff(GUID, [1463]);
  expect(refreshed.begin).toEqual([]);
  expect(refreshed.reap).toEqual([]);

  // A second aura with no state kit joins it: still no edge, and the counter says WHY rather than
  // leaving it silent.
  const withOther = kits.diff(GUID, [1463, 168]);
  expect(withOther.begin).toEqual([]);
  expect(kits.stats.noStateKit).toBe(1);

  // The buff falls off. The reap names the spell id, which is the key the instance was armed under.
  const gone = kits.diff(GUID, [168]);
  expect(gone.reap).toEqual([1463]);
  expect(gone.begin).toEqual([]);

  // And it does not reap twice -- the armed set dropped it with the edge.
  expect(kits.diff(GUID, [168]).reap).toEqual([]);
  expect(kits.stats.armed).toBe(1);
  expect(kits.stats.reaped).toBe(1);
});

test('the same spell in two slots is one instance, and duplicates never re-arm', () => {
  const kits = new AuraStateKits();

  // Two casters applied it, so the server holds two slots for one spell id. The reference dedupes
  // for the same reason: one state instance either way.
  const applied = kits.diff(GUID, [1463, 1463]);
  expect(applied.begin).toEqual([{ spellId: 1463, kitId: 990 }]);

  // One of the two drops. The spell id is still in the slots, so there is no reap: the visual belongs
  // to the id, not to the slot.
  expect(kits.diff(GUID, [1463]).reap).toEqual([]);
  expect(kits.stats.armed).toBe(1);
});
