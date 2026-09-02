import { resolveCastTarget, castTargetWord } from '../cast-target';
import { SpellRow } from '../../pipeline/dbc/spell-data';
import { REACTION_FRIENDLY, REACTION_HOSTILE } from '../../world/faction';

/**
 * **THE CAST TARGET WALK -- the owner's "I cannot heal while an enemy is targeted".**
 *
 * The four rows below are the REAL served `Spell.dbc` values, read off
 * `dbfilesclient/spell.dbc` (49839 records / 234 fields / 936 B) at the two measured columns 16 and
 * 86 -- so a column named at the wrong index fails here rather than agreeing with itself. That is
 * the same discipline `wow-data-parser/dbc/entities/__tests__/spell-visual.test.js` follows, and it
 * matters more here because `Targets` is **0 for a heal, a nuke and a self-buff alike**: a fixture
 * built from the declaration could not tell them apart.
 *
 * WHICH LAYER: the pure resolver. No packets, no VM, no scene -- `resolveCastTarget` is a function
 * of a row, two guids, a boolean and two units. It says nothing about whether the packet the
 * decision produces is accepted; the wire shapes it chooses between are both shapes `castSpell`
 * already sent, which is stated there.
 */

/** A row with only the two targeting columns filled -- everything else is irrelevant here. */
const row = (targets: number, implicitTargetA0: number): SpellRow => ({
  targets, implicitTargetA0,
} as unknown as SpellRow);

/** Real values. Lesser Heal 2050: `Targets` 0, implicit arm 21 (friendly unit). */
const LESSER_HEAL = row(0x0000, 21);
/** Frost Armor 168: `Targets` 0, implicit arm 1 -- a self-only buff. */
const FROST_ARMOR = row(0x0000, 1);
/** Fireball 133: `Targets` 0, implicit arm 6 (enemy unit). */
const FIREBALL = row(0x0000, 6);
/** Flamestrike 2120: `Targets` 0x40, implicit arm 16 -- the ground cursor. */
const FLAMESTRIKE = row(0x0040, 16);

const SELF = '0xF130000001';
const WOLF = '0xF130000002';

/** A `Unit`-shaped double: only `reaction`, `health` and the flag word are read. */
const unit = (reaction: number) => ({
  reaction,
  health: 100,
  fields: { unitFlags: 0, factionTemplate: 1 },
} as never);

const hostile = { target: unit(REACTION_HOSTILE), self: unit(REACTION_FRIENDLY) };

it('a heal with an ENEMY targeted falls back to the caster, and a nuke does not', () => {
  // The word: `Targets` 0 plus arm 21 = TF_UNIT_ASSIST. A target IS required, and a hostile one
  // cannot satisfy it -- so candidate 2, ourselves, takes it. This is the owner's report.
  expect(castTargetWord(LESSER_HEAL)).toBe(0x0100);
  expect(resolveCastTarget(LESSER_HEAL, WOLF, SELF, true, hostile))
    .toEqual({ kind: 'unit', guid: SELF });

  // With the CVar off the fallback is gated and the press is refused rather than redirected --
  // the reference's own gate, and the reason the default is a CVar and not a constant.
  expect(resolveCastTarget(LESSER_HEAL, WOLF, SELF, false, hostile).kind).toBe('refused');

  // A NUKE is unaffected: arm 6 sets TF_UNIT_ENEMY, which the wolf satisfies, so it binds the
  // selection exactly as before. A fallback that fired here would cast Fireball at ourselves.
  expect(castTargetWord(FIREBALL)).toBe(0x0080);
  expect(resolveCastTarget(FIREBALL, WOLF, SELF, true, hostile))
    .toEqual({ kind: 'unit', guid: WOLF });
});

it('a self-buff ships TARGET_FLAG_SELF with no guid even with an enemy selected', () => {
  // Arm 1 leaves the word at ZERO, which means "this cast needs no target at all". The reference is
  // emphatic that the real client never ships the selection for these, and shipping it is what made
  // a self-buff refused whenever anything was targeted.
  expect(castTargetWord(FROST_ARMOR)).toBe(0);
  expect(resolveCastTarget(FROST_ARMOR, WOLF, SELF, true, hostile))
    .toEqual({ kind: 'self-implicit' });

  // A ground spell is REFUSED rather than aimed at the selection: it needs the targeting cursor,
  // which is a named gap. Sending it at the wolf is what happens today.
  expect(resolveCastTarget(FLAMESTRIKE, WOLF, SELF, true, hostile).kind).toBe('refused');
});
