import { SpellRow } from '../pipeline/dbc/spell-data';

/**
 * **DOES USING THIS SPELL START THE MELEE AUTO-ATTACK?**
 *
 * The owner: "Нужно сделать так, чтобы автоатака начиналась автоматически после первого удара."
 * Auto-attack should start by itself once he lands his first hit rather than needing to be started
 * separately.
 *
 * **THIS IS A DATA RULE, NOT "ANY DAMAGE STARTS A SWING".** The real client decides it from the
 * spell's own attribute words at the moment the cast is sent, and the reference transcribes that
 * predicate byte for byte -- `benilla-formats/src/spells/display.rs:601-605`
 * (`SpellDisplay::initiates_auto_attack`), consumed by `TryCast`'s post-send tail
 * (`benilla-app/src/ui_action/cast_send.rs:601-630`, byte-verified whole against `6e51b5` by wow-re
 * `combat-feel-law.md` §5 @ c445713b):
 *
 *     (Attributes & 0x404) || (AttributesEx1 & 0x200)      -- either leg starts it
 *     && (AttributesEx2 & 0x00100000) == 0                 -- unless this defers it to SPELL_GO
 *
 * ## The three bits, and why the union matters
 *
 * - **`Attributes & 0x404` -- ON-NEXT-SWING** (`spells/mod.rs:434-437`). Such a spell does not cast
 *   at all: it queues on the server's melee slot and fires on the caster's next swing, so using one
 *   necessarily means swinging. Heroic Strike 78 and Cleave 845 carry `0x4`, Raptor Strike 2973
 *   `0x404`.
 * - **`AttributesEx1 & 0x200` -- INITIATES COMBAT** (`spells/mod.rs:438-444`, vmangos
 *   `SPELL_ATTR_EX_INITIATES_COMBAT`, "Enables Auto-Attack"). The SERVER only reads this for pet AI
 *   (vmangos `Spell.cpp:4377`); the player-facing "casting this starts my auto-attack" is
 *   client-side, which is why it has to be done here at all.
 * - **`AttributesEx2 & 0x100000` -- POST-CAST DEFER** (`spells/mod.rs:448-454`, vmangos
 *   `SPELL_ATTR_EX2_INITIATE_COMBAT_POST_CAST`, "Client will send CMSG_ATTACK_SWING after
 *   SMSG_SPELL_GO"). A spell carrying it starts its attack from the GO handler (`0x6e83c0`) instead
 *   of at send, so the send-time predicate must EXCLUDE it.
 *
 * **THE UNION IS THE WHOLE POINT AND A SINGLE-BIT TEST WOULD HAVE MISSED HALF THE FAMILY.** Measured
 * on the served `dbfilesclient/spell.dbc` (49839 records / 234 fields / 936 B, so a field index is
 * the offset / 4): the predicate is true for **1139** spells -- **408 via on-next-swing only, 768 via
 * initiates-combat only, 26 via both**. Heroic Strike 78 is in the first group and carries NO `0x200`
 * (`Attributes 0x00050014`, `AttributesEx1 0x08000000`), so a `0x200`-only reading would have left
 * the archetypal warrior strike out; Sinister Strike 1752 is in the second (`AttributesEx1
 * 0x08000200`) and carries no on-next-swing bit, so an on-next-swing-only reading would have left
 * out every rogue and most warrior abilities. Both of those are exactly the anchors this was asked to
 * produce, and each is covered by a different leg.
 *
 * The reference's own named cases reproduce on this build, which is what pins the bits rather than
 * porting them: it says "Rend/Sunder Armor/Slam/Sinister Strike carry it; **Heroic Strike and Charge
 * do not**", and here Rend 772, Sunder Armor 7386, Slam 1464 and Sinister Strike 1752 all read
 * `AttributesEx1 & 0x200` while Heroic Strike 78 and **Charge 100** read none of it. Charge is the
 * sharp negative: it carries `0x400` in `AttributesEx1`, which is a DIFFERENT bit from the on-next-
 * swing `0x400` in `Attributes`, so a predicate that read the wrong word would have started a swing
 * on every Charge.
 *
 * Also verified as NOT starting: Intercept 20252, Auto Shot 75, Shoot 3018, Divine Storm 53385,
 * Frost Armor 168, Battle Shout 6673, Fireball 133, Lesser Heal 2050, and Auto Attack 6603 itself.
 *
 * ## The columns are MEASURED, not ported
 *
 * `Attributes` is column 4 and the 8-word block 4-11 is established in `spell-data.ts#COL.attributes`
 * two independent ways. `AttributesEx1` at column 5 is corroborated by a THIRD measurement already in
 * the repo and made for another purpose entirely: `dbc/entities/spell-visual.js` splits visuals by
 * `AttributesEx1 & 0x44` (the channelled mask) at column 5 and gets 86.6% against 1.1% -- a 79x
 * discrimination that could only land if column 5 is that word and vmangos' bit values are this
 * build's. The same file's own field arithmetic reaches `interruptFlags` at 31 and `speed` at 47,
 * both of which this project measured separately.
 *
 * ## A 3.3.5a DIFFERENCE the reference could not have seen
 *
 * The reference records that **no** 1.12 spell carries the post-cast-defer bit ("asserted against the
 * real 5875 `Spell.dbc`"), so it leaves the deferred path unbuilt and the bit only ever suppresses.
 * **On 3.3.5a the bit IS populated: 77 spells carry it, and 63 of those would otherwise have started
 * at send.** So the exclusion below is load-bearing on this build rather than dead code -- and the
 * deferred start at `SMSG_SPELL_GO` is a real named gap here where it was vacuous there. See the
 * round report; those 63 spells start no auto-attack at all rather than starting one late.
 */

/** `Attributes` -- ON-NEXT-SWING. Either bit; the reference's `ATTR_ON_NEXT_SWING`. */
export const ATTR_ON_NEXT_SWING = 0x404;

/** `AttributesEx1` -- INITIATES COMBAT / "Enables Auto-Attack". */
export const ATTR_EX1_INITIATES_COMBAT = 0x200;

/** `AttributesEx2` -- the start is deferred to `SMSG_SPELL_GO`, so it must NOT happen at send. */
export const ATTR_EX2_INITIATE_COMBAT_POST_CAST = 0x00100000;

/**
 * The reference's `initiates_auto_attack`, verbatim in structure.
 *
 * A null row answers FALSE, and that is deliberate rather than a fail-open: `Spell.dbc` is 49 MB and
 * is not loaded during the login burst, so an unknown spell here means "the table has not arrived".
 * Starting a swing on that guess would swing at whatever is selected for reasons the player cannot
 * see, and the Attack button remains the way to start one by hand.
 */
export function initiatesAutoAttack(row: SpellRow | null): boolean {
  if (row === null) {
    return false;
  }
  if ((row.attributesEx2 & ATTR_EX2_INITIATE_COMBAT_POST_CAST) !== 0) {
    return false;
  }
  return (row.attributes & ATTR_ON_NEXT_SWING) !== 0
    || (row.attributesEx1 & ATTR_EX1_INITIATES_COMBAT) !== 0;
}
