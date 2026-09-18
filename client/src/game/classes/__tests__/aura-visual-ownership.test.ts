import { AuraStateKits } from '../aura-visual';

/**
 * **OWNERSHIP ACROSS AN ABSENT BODY -- the shield that could never be reaped.**
 *
 * The absent-body branch in `network/game/object/aura-visuals.ts` used to call `forget(guid)`, which
 * drops ownership of EVERY spell for that guid. Any instance armed by an earlier diff was then
 * orphaned permanently: nothing could reap it, because the record it would be found by was gone. Its
 * comment defended this as safe because "a re-arm replaces instead of stacking" -- true only for a
 * spell that later gets re-armed, which a shield cast once and kept never is.
 *
 * These assert the two edges the old code could not tell apart: a BLINK keeps what it owns, and a
 * DESPAWN (an empty slot list) reaps everything and drops the record.
 *
 * WHICH LAYER: the pure diff. It says nothing about models, the scene, or whether
 * `SpellKitEffects#reap` matched an instance -- `spellKitEffects.stats.reaped` is the instrument for
 * that half and it lives in another module deliberately.
 */

jest.mock('../../pipeline/dbc/spell-data', () => ({
  spellData: {
    // Ice Barrier 11426 -> state kit 3672, and Mana Shield 1463 -> 990. Both real chains.
    stateKit: (spellId: number) => ({ 11426: 3672, 1463: 990 } as Record<number, number>)[spellId] ?? null,
  },
}));

jest.mock('../spell-kit-fx', () => ({
  kitEmitters: (kitId: number) => (kitId === 3672 || kitId === 990
    ? [{ slot: 2, tag: 0x13, effectId: 1, modelPath: 'x.mdx' }]
    : []),
}));

jest.mock('../../ui/framexml/lua/methods/region', () => ({ warnOnce: () => undefined }));

const GUID = '0x0000000000000001';
const ICE_BARRIER = 11426;
const MANA_SHIELD = 1463;

it('an absent body disowns only what it could not arm, and keeps the live shield', () => {
  const kits = new AuraStateKits();

  // The shield goes up while the body is present: armed and owned.
  expect(kits.diff(GUID, [ICE_BARRIER]).begin).toEqual([{ spellId: ICE_BARRIER, kitId: 3672 }]);

  // A second buff lands during a moment when the body is NOT in the world, so the caller cannot arm
  // it. It disowns just that one -- the way the absent-body branch now does.
  const second = kits.diff(GUID, [ICE_BARRIER, MANA_SHIELD]);
  expect(second.begin).toEqual([{ spellId: MANA_SHIELD, kitId: 990 }]);
  kits.unarm(GUID, second.begin.map((b) => b.spellId));

  // THE FIX: the shield is still owned, so it can still be reaped. Under the old blanket `forget`
  // this came back empty and the instance was orphaned for the rest of the session.
  expect(kits.diff(GUID, []).reap).toEqual([ICE_BARRIER]);

  // And the un-armed one is NOT reaped: no instance was ever created for it, so claiming to reap it
  // would be a reap decision with nothing behind it -- the shape the counters must not report.
  expect(kits.diff(GUID, []).reap).toEqual([]);
});

it('a despawn arrives as an empty slot list, which reaps everything and drops the record', () => {
  const kits = new AuraStateKits();

  kits.diff(GUID, [ICE_BARRIER, MANA_SHIELD]);
  // `SMSG_DESTROY_OBJECT` -> `AuraHandler#forget` -> `'auras'` -> this diff with nothing live.
  expect(kits.diff(GUID, []).reap.sort()).toEqual([MANA_SHIELD, ICE_BARRIER].sort());
  // The record dropped itself, so a guid that streams back in is not mistaken for already-armed.
  expect(kits.trackedUnits).toBe(0);
});
