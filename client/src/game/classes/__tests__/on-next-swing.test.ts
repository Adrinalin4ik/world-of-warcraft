import { isOnNextSwing, initiatesAutoAttack } from '../auto-attack-start';
import { SpellRow } from '../../pipeline/dbc/spell-data';

/**
 * **THE ON-NEXT-SWING CLASS -- the queueing predicate, and how it differs from the swing-STARTING
 * one.**
 *
 * The owner: "еще некоторые скилы, например у хантера или вара работают под следующий свинг."
 *
 * Every `Attributes` word below is READ OFF the served `dbfilesclient/spell.dbc` at column 4, not
 * synthesised. The two questions are deliberately separate functions and this pins the difference:
 * Sinister Strike STARTS the swing but does not QUEUE, and conflating them would have queued a spell
 * the server does not hold in its melee slot.
 */

const row = (attributes: number, attributesEx1 = 0, attributesEx2 = 0): SpellRow => ({
  attributes, attributesEx1, attributesEx2,
} as unknown as SpellRow);

it('both bit positions queue, and each requested anchor lands on a different leg', () => {
  // Heroic Strike 78 and Cleave 845 -- the PRIMARY bit 0x4 only (321 spells carry it).
  expect(isOnNextSwing(row(0x00050014))).toBe(true);
  // Raptor Strike 2973 -- BOTH bits (37 spells). The hunter anchor.
  expect(isOnNextSwing(row(0x00050404))).toBe(true);
  // A creature ability with the SECONDARY bit 0x400 alone -- Savage Assault 91 (150 spells). A
  // primary-only test would drop the whole creature half.
  expect(isOnNextSwing(row(0x00040410))).toBe(true);

  // Slam 1464 carries NEITHER, and that is correct: Slam is a cast-time melee ability, not queued.
  expect(isOnNextSwing(row(0x00250110))).toBe(false);
  // Fireball 133, and no row at all.
  expect(isOnNextSwing(row(0x00010000))).toBe(false);
  expect(isOnNextSwing(null)).toBe(false);
});

it('queueing and swing-STARTING are different questions', () => {
  // Sinister Strike 1752: starts the auto-attack via AttributesEx1 0x200, but does NOT queue --
  // no on-next-swing bit in Attributes. Conflating the two would have put it in the melee slot.
  const sinister = row(0x00050010, 0x08000200);
  expect(initiatesAutoAttack(sinister)).toBe(true);
  expect(isOnNextSwing(sinister)).toBe(false);

  // Heroic Strike 78: BOTH -- it queues, and queueing is itself what starts the swing.
  const heroic = row(0x00050014, 0x08000000);
  expect(initiatesAutoAttack(heroic)).toBe(true);
  expect(isOnNextSwing(heroic)).toBe(true);

  // The post-cast-defer bit suppresses the swing START but says nothing about queueing, so the two
  // predicates diverge on it deliberately.
  const deferred = row(0x00050014, 0x08000000, 0x00100000);
  expect(initiatesAutoAttack(deferred)).toBe(false);
  expect(isOnNextSwing(deferred)).toBe(true);
});
