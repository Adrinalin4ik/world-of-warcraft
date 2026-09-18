import { initiatesAutoAttack } from '../auto-attack-start';
import { SpellRow } from '../../pipeline/dbc/spell-data';

/**
 * **THE MELEE-COMBAT-START PREDICATE, on the real served attribute words.**
 *
 * The owner: "Нужно сделать так, чтобы автоатака начиналась автоматически после первого удара."
 *
 * Every triple below is READ OFF the served `dbfilesclient/spell.dbc` (49839 records / 234 fields /
 * 936 B) at columns 4, 5 and 6, not synthesised -- which is what makes this a check on the predicate
 * rather than on the fixture. `Attributes` is 0 for none of these by accident: the whole point is
 * that the two positive legs live in DIFFERENT words, so a fixture built from one column could not
 * tell the two families apart.
 *
 * WHICH LAYER: the pure predicate. It says nothing about whether `CMSG_ATTACKSWING` goes out -- the
 * four gates on that (committed send, bound unit target, not ourselves, not already engaged) live at
 * the send tail in `network/game/object/spells.ts`, and whether the character actually swings is the
 * owner's to see.
 */

/** Only the three attribute words matter here. */
const row = (attributes: number, attributesEx1: number, attributesEx2: number): SpellRow => ({
  attributes, attributesEx1, attributesEx2,
} as unknown as SpellRow);

it('BOTH legs start the swing, and each anchor is covered by a different one', () => {
  // Heroic Strike 78 -- ON-NEXT-SWING only. Carries NO 0x200 at all, so a `0x200`-only reading would
  // have left the archetypal warrior strike out. 408 spells are in this group.
  expect(initiatesAutoAttack(row(0x00050014, 0x08000000, 0x00000000))).toBe(true);

  // Sinister Strike 1752 -- INITIATES-COMBAT only, no on-next-swing bit. 768 spells here, so an
  // on-next-swing-only reading would have missed most of the melee family.
  expect(initiatesAutoAttack(row(0x00050010, 0x08000200, 0x00000000))).toBe(true);

  // Cleave 845 -- both legs at once (26 spells do this).
  expect(initiatesAutoAttack(row(0x00050014, 0x00000200, 0x00001000))).toBe(true);

  // Raptor Strike 2973 -- the full 0x404 form of the on-next-swing bit rather than 0x4.
  expect(initiatesAutoAttack(row(0x00050404, 0x00000000, 0x00000000))).toBe(true);
});

it('the reference\'s negative anchors do not, and Charge is the sharp one', () => {
  // CHARGE 100. The reference names it explicitly ("Heroic Strike and Charge do not") and it is the
  // case a wrong-word read would get wrong: it carries 0x400 in AttributesEx1, which is a DIFFERENT
  // bit from the on-next-swing 0x400 in Attributes. Testing the wrong word starts a swing on every
  // Charge.
  expect(initiatesAutoAttack(row(0x30050010, 0x00000400, 0x00000000))).toBe(false);
  // Intercept 20252 -- the same shape.
  expect(initiatesAutoAttack(row(0x20050010, 0x00000400, 0x00000000))).toBe(false);
  // Fireball 133 and Divine Storm 53385: damage, and no swing. "Any damage starts a swing" is the
  // reading this predicate exists to avoid.
  expect(initiatesAutoAttack(row(0x00010000, 0x00000000, 0x00000000))).toBe(false);
  expect(initiatesAutoAttack(row(0x00050000, 0x00000010, 0x00000000))).toBe(false);
  // Auto Shot 75 -- ranged, and it must not start MELEE.
  expect(initiatesAutoAttack(row(0x00050012, 0x00000000, 0x00000020))).toBe(false);

  // THE POST-CAST DEFER EXCLUSION, which is live on 3.3.5a (77 carriers, 63 of them otherwise
  // starters) where the reference found none in 1.12. Same words as Sinister Strike plus Ex2 bit 20:
  // the start belongs to the SPELL_GO handler, so the send-time predicate must refuse it.
  expect(initiatesAutoAttack(row(0x00050010, 0x08000200, 0x00100000))).toBe(false);

  // No row: the 49 MB table has not landed. False rather than a guess.
  expect(initiatesAutoAttack(null)).toBe(false);
});
