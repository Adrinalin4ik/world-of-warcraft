/**
 * The spell tables an action bar needs: a spell's icon, its name, and the animation its cast plays.
 *
 * ## Why `Spell.dbc` does NOT go through `DBC.load`
 *
 * Every other table in this client is decoded by `wow-data-parser/dbc` through the worker pool, and
 * `entities/spell.js` is the canonical definition of a `Spell.dbc` row -- corrected for 3.3.5a in the
 * same change that added this file. `Spell.dbc` is nevertheless read here by hand, for a reason that is
 * a measurement and not a preference:
 *
 *   the served `dbfilesclient/spell.dbc` is **48,967,121 bytes** -- `recordCount = 49839`,
 *   `fieldCount = 234`, `recordSize = 936`, plus a 2.3 MB string block.
 *
 * Handing that to `restructure` means 49,839 records x 234 columns, including four `LocalizedStringRef`
 * blocks that are 17 pointer decodes each -- roughly 15 million field decodes to obtain two columns per
 * row. The nine columns below are read with a `DataView` instead, which is one pass and no allocation
 * per row beyond the entries actually wanted.
 *
 * The 49 MB DOWNLOAD is unavoidable and is not hidden: a DBC has no index, so there is no way to reach
 * record N without the bytes before it, and the file is only sorted by id by convention. It is fetched
 * ONCE and the browser caches it. The real client reads this table out of a local MPQ, so there is no
 * upstream design to copy here.
 *
 * **WHO calls `ensureLoaded` is load-bearing, and it is NOT the packet handler.** Firing it from
 * `SMSG_INITIAL_SPELLS` -- which arrives in the login burst -- put this 49 MB fetch in contention with
 * `FrameXML.toc`'s 264 small fetches over the same connection and STARVED them: measured, the FrameXML
 * boot did not finish in 240 s and `window.worldRuntime` never appeared, with nothing logged anywhere.
 * The caller is `ui/action-bridge.ts`, which attaches only after the manifest is loaded. Every consumer
 * tolerates "not yet" and the bridge re-pushes when this settles, so the bar comes up with the right
 * shape first and the icons land a moment later.
 *
 * `SpellIcon` (152 KB), `SpellVisual` (1.2 MB) and `SpellVisualKit` (1.3 MB) DO go through `DBC.load`,
 * because their entity definitions are deliberately narrow (`entities/spell-visual.js`,
 * `entities/spell-visual-kit.js`) and `stridedRecord` makes a narrow definition cheap.
 *
 * ## Where the column indices come from
 *
 * Measured against the served file, not transcribed. `recordSize` is exactly `fieldCount * 4`, so every
 * column is 4 bytes wide and a field index IS its byte offset / 4. The two load-bearing indices were
 * found by scanning spell 133's record for the column that resolves to the string "Fireball" (index
 * **136**) and the column whose value is a `SpellIcon.dbc` id naming `Spell_Fire_FlameBolt` (index
 * **133**). Ten known spells then decode with correct name, rank and icon; the check is repeated as a
 * unit test against a synthesised record so a future edit cannot shift them silently.
 *
 * `manaCost` corroborates independently: Heroic Strike rank 1 reads 150 and Battle Shout rank 1 reads
 * 100, which are 15 and 10 rage -- rage is stored x10 -- and both carry `powerType = 1` (rage) while
 * Eviscerate carries `powerType = 3` (energy).
 *
 * ## THE GLOBAL COOLDOWN's column, measured
 *
 * `StartRecoveryTime` is **column 206** and `StartRecoveryCategory` is **205**. Derived from
 * `wow-data-parser/dbc/entities/spell.js` -- which the four indices above already corroborate, and whose
 * total is exactly the file's 234 -- and then verified by reading the served `spell.dbc` directly
 * (header + the first 2000 records, over an HTTP range request):
 *
 *     spell  133 Fireball        col 205 = 133   col 206 = 1500
 *     spell  331 Healing Wave    col 205 = 133   col 206 = 1500
 *     spell  403 Lightning Bolt  col 205 = 133   col 206 = 1500
 *     spell 1752 Sinister Strike col 205 = 133   col 206 = 1000
 *     spell 2098 Eviscerate      col 205 = 133   col 206 = 1000
 *     spell   78 Heroic Strike   col 205 = 0     col 206 = 0
 *     spell 6603 Auto Attack     col 205 = 0     col 206 = 0
 *
 * That is the 3.3.5a rule reading back exactly: 1.5 s for a spell, 1.0 s for an energy ability, and
 * ZERO for Heroic Strike and Auto Attack, which are on-next-swing and genuinely off the global cooldown.
 * Category 133 is the shared GCD group; category 0 is "this spell triggers no GCD".
 *
 * **The GCD is not on the wire.** Nothing the server sends carries it -- `SMSG_SPELL_GO` has
 * `castFlags` and a timestamp and no recovery field, and `SMSG_SPELL_COOLDOWN` (0x134) carries only real
 * per-spell cooldowns. The 3.3.5a client computes the global cooldown ITSELF from this column when a cast
 * is confirmed, which is why it appears instantly in the real client and why this is a DBC read and not a
 * packet decode. `recoveryTimeMs` (29) and `categoryRecoveryTimeMs` (30) are the real cooldowns and read
 * 0 for every spell sampled above, so on these characters the GCD is the only cooldown to be seen.
 */
import DBC from './index';
import Loader from '../../net/loader';
import { spellWire } from '../../classes/spell-wire';

/** `Spell.dbc` column indices for 3.3.5a build 12340. See the header for how each was established. */
const COL = {
  id: 0,
  /** `Category` -- the shared-cooldown group `CategoryRecoveryTime` applies across. */
  category: 1,
  /**
   * `DispelType` -> `SpellDispelType.dbc`, which is what a DEBUFF's border colour is keyed by.
   *
   * VERIFIED AGAINST THE GAME'S OWN DATA rather than taken from an enum header: the served
   * `DBFilesClient/SpellDispelType.dbc` is 12 rows and its name column reads, in id order, `None`,
   * `Magic`, `Curse`, `Disease`, `Poison`, `Stealth`, `Invisibility`, `All(M+C+D+P)`,
   * `Special - npc only`, `Enrage`, `ZG Trinkets`, `ZZOLD UNUSED`. The client's own
   * `DebuffTypeColor` table is keyed by exactly four of those strings -- Magic, Curse, Disease, Poison
   * (`buffframe.lua:16-21`) -- so 1..4 are the only ids `UnitAura`'s fifth return may name, and
   * anything else must come back nil (see `ui/aura-bridge.ts#dispelName`).
   *
   * Column 2, between `Category` and `Mechanic`, per `wow-data-parser/dbc/entities/spell.js:9`.
   */
  dispelType: 2,
  /**
   * `Attributes` -- the first attribute word. Bit `0x40` is `SPELL_ATTR0_PASSIVE`, which is what
   * `IsPassiveSpell` answers and what makes a spellbook entry draw a black button border and a grey
   * name instead of a clickable icon (`spellbookframe.lua:496-506`).
   *
   * MEASURED on the served file, and it discriminates cleanly on ten samples -- four known passives read
   * the bit and six known actives do not:
   *
   *      674 Dual Wield        attrs 0x00000050  passive 1   (NameSubtext "Passive")
   *      750 Plate Mail        attrs 0x000000c0  passive 1
   *     8737 Mail              attrs 0x000000c0  passive 1
   *    20579 Shadow Resistance attrs 0x00000050  passive 1   (NameSubtext "Racial Passive")
   *      331 Healing Wave      attrs 0x00010000  passive 0
   *      403 Lightning Bolt    attrs 0x00010000  passive 0
   *       78 Heroic Strike     attrs 0x00050014  passive 0
   *    20594 Stoneform         attrs 0x00040100  passive 0   (NameSubtext "Racial", and NOT passive)
   *
   * The last pair is the useful one: "Racial" and "Racial Passive" differ in the subtext by one word, so
   * a reader that guessed passiveness from the NAME would get Stoneform wrong. The attribute bit does not.
   *
   * **Bit `0x80` in the same word is the DO-NOT-DISPLAY flag**, and it is the whole of the spellbook's
   * filter. See `SpellRow#hiddenInSpellbook` for the measurement.
   *
   * The 8-word layout is confirmed two ways rather than assumed: `wow-data-parser/dbc/entities/spell.js:12`
   * declares `attributes: new r.Array(r.uint32le, 8)` right after `id, categoryID, dispelID, mechanicID`,
   * so columns **4-11** are `Attributes` + `AttributesEx1..Ex7` and column 12 is `stances` -- and the served
   * file agrees, column 12's maximum being `0xf807e0ff`, a shapeshift-form mask and not an attribute word.
   */
  attributes: 4,
  castingTimeIndex: 28,
  /**
   * `InterruptFlags` -- what BREAKS a cast in progress. Bit 0x1 is
   * `SPELL_INTERRUPT_FLAG_MOVEMENT`, the movement self-cancel's gate (`game/classes/cast-cancel.ts`).
   *
   * **Column 31 is MEASURED, not ported.** The reference is 1.12 and states the field as `SpellRec+0x54`
   * (`samples/benilla/crates/benilla-app/src/ui_cast.rs:336`), which is a 1.12 byte offset and says
   * nothing about a 3.3.5a column index. What pins it is that the reference also records four
   * byte-verified VALUES -- "Heroic Strike 78, Cleave 845, Raptor Strike 2973 all ship `InterruptFlags =
   * 0x0` ... vs Fireball's `0xf`" (`ui_cast.rs:447-450`) -- and column 31 is the **only** column in the
   * served 3.3.5a `Spell.dbc` that satisfies all four at once: a scan of columns 1-59 for
   * `spell[133] == 0xf && spell[78] == spell[845] == spell[2973] == 0` returns exactly `[31]`.
   *
   * It corroborates the declaration independently: `dbc/entities/spell.js` reaches `interruptFlags` at
   * declared index 31 by its own field arithmetic, and so does `speed` at 47 (Fireball reads 24.0 there),
   * which was checked in the same pass.
   */
  interruptFlags: 31,
  /**
   * `ChannelInterruptFlags` -- what breaks a CHANNEL. Bit 0x8 is `AURA_INTERRUPT_FLAG_MOVE`, the
   * channel half of the movement cancel (`ui_cast.rs:337`).
   *
   * Two columns after `interruptFlags`, with `AuraInterruptFlags` between them, which is the order
   * `dbc/entities/spell.js:37-39` declares. Read back off the served file, every channelled spell
   * checked carries **0x7c0c** here -- Mind Flay 15407, Drain Life 689, Health Funnel 755, Hellfire
   * 1949 -- and `0x7c0c & 0x8` is set, so movement cancels all four. Fireball (not a channel) and
   * Heroic Strike both read 0.
   */
  channelInterruptFlags: 33,
  /**
   * `SpellLevel` -- the character level this rank of the spell is learned at.
   *
   * Read for ONE purpose: deciding which member of a rank family is the HIGHEST rank, which the
   * spellbook needs because `ShowAllSpellRanks` is off by default and the book then lists only the top
   * rank of each spell. It ascends monotonically with rank, measured across two families:
   *
   *     Lightning Bolt  403 r1 lvl 1,  529 r2 lvl 8,  548 r3 lvl 14,  915 r4 lvl 20,  943 r5 lvl 26
   *     Healing Wave    331 r1 lvl 1,  332 r2 lvl 6,  547 r3 lvl 12
   *
   * **`SkillLineAbility`'s `forward_spellid` (its column 8) is NOT the rank chain in 3.3.5a, and that was
   * measured rather than assumed** -- it reads **0** for all eight of the spells above, and its 1059
   * non-zero rows cluster on skill lines 134 Feral Combat, 253 Assassination and 256 Fury, which is
   * talent forwarding and not ranks. So the obvious column does not work and this one is what does.
   */
  spellLevel: 39,
  /** `RecoveryTime` (ms): this spell's OWN cooldown. */
  recoveryTime: 29,
  /** `CategoryRecoveryTime` (ms): the cooldown put on every spell sharing `category`. */
  categoryRecoveryTime: 30,
  powerType: 41,
  manaCost: 42,
  /** `rangeIndex` -> `SpellRange.dbc`, which is what `IsActionInRange` needs. */
  rangeIndex: 46,
  /** `ManaCostPercentage` -- a PERCENT OF BASE MANA, used instead of `manaCost` by most caster spells. */
  manaCostPercentage: 204,
  /** `StartRecoveryCategory`: 133 is the shared global-cooldown group; 0 means the spell is off-GCD. */
  startRecoveryCategory: 205,
  /** `StartRecoveryTime` (ms) -- THE GLOBAL COOLDOWN. See the header for the measurement. */
  startRecoveryTime: 206,
  /** `SpellVisualID[0]`. `[1]` at 132 is the second visual and is not read. */
  visual: 131,
  iconID: 133,
  activeIconID: 134,
  /** First locale slot of the `Name` block; 3.3.5a localised strings are 16 locales + a flags word. */
  name: 136,
  /**
   * `NameSubtext` -- THE RANK STRING, and `GetSpellName`'s second return (`subSpellName`).
   *
   * Derived from the block chain and then read back off the served file. The chain closes exactly, which
   * is the corroboration: `Name` at 136 + 17 = **153** `NameSubtext`, + 17 = 170 `Description`,
   * + 17 = 187 `AuraDescription`, + 17 = **204**, which is `manaCostPercentage` -- a column that was
   * already established independently two rounds ago. Four localised blocks of 17 land exactly on a known
   * column, so no index in the run can be off by one.
   *
   * Read back, it is what the spellbook draws under a spell's name: "Rank 1", "Rank 2", "Rank 3" for the
   * Lightning Bolt family, "Passive" for 674 Dual Wield, "Racial Passive" for 20579 Shadow Resistance,
   * "Racial" for 20594 Stoneform, and the EMPTY string for 750 Plate Mail and 8737 Mail.
   *
   * The empty case is load-bearing: `SpellButton_UpdateButton` compares `subSpellName ~= ""` to decide
   * where to anchor the name label (`spellbookframe.lua:510-514`), so this must reach Lua as `""` and
   * never as nil -- a nil there makes the comparison true and shifts the label by two units for every
   * rankless spell.
   */
  nameSubtext: 153,
  /**
   * `Description` -- the spell's tooltip body, and the third block in the chain `nameSubtext` documents:
   * `Name` 136 + 17 = 153 `NameSubtext` + 17 = **170** `Description` + 17 = 187 `AuraDescription` + 17 =
   * 204 `manaCostPercentage`, a column established independently. No index in that run can be off by one.
   *
   * Read for the tooltip, which had nothing to say (`GameTooltip:SetSpell`/`SetAction`).
   *
   * **The `$`-VARIABLES ARE NOT EXPANDED and that is a stated gap.** A 3.3.5a description carries the
   * engine's own substitution tokens -- `$s1` for effect 1's value, `$d` for the duration, `$/1000;s2`
   * for a scaled one -- which the real client resolves from `Spell.dbc`'s effect columns, the caster's
   * level and his spell power. None of those columns is read here, so the raw string reaches the tooltip
   * with its tokens visible. That is deliberately not hidden behind a regex that strips them: a stripped
   * token reads as a finished sentence with a number missing, which is the silent-wrong-answer shape this
   * project's rules forbid, while a visible `$s1` says exactly what has not been computed.
   */
  description: 170,

  // -- THE EFFECT BLOCK and its neighbours: everything a `$` token in a description resolves through.
  //
  // WHERE THESE INDICES COME FROM. Not one of them is guessed and none is new evidence: they are read
  // straight off `wow-data-parser/dbc/entities/spell.js`, whose declared widths, summed in order, come
  // to exactly the file's **234** columns -- and five of the columns in that sum are already
  // established INDEPENDENTLY against the served bytes (133 `iconID`, 136 `Name`, 153 `NameSubtext`,
  // 170 `Description`, 204 `manaCostPercentage`, 205/206 the GCD pair; see the comments above). A run
  // that lands on five known columns cannot be off by one anywhere between them, and the effect block
  // at 71..121 sits inside that run.
  //
  // Each is the FIRST of three per-effect words; effect n (1-based) is `COL.x + n - 1`.
  /**
   * `Effect[0..2]` -- the SPELL_EFFECT_* id of each effect slot, the first word of the block this
   * comment describes. `effectDieSides: 74` three lines below is what pins it: the block is three
   * words per column, so `Effect` is `74 - 3 = 71`.
   *
   * MEASURED against the served file rather than reasoned about, because one caller depends on the
   * exact value: spell **7266 "Duel"** (name column 136) reads `Effect[0..2] = 83, 0, 0` in
   * `12340/dbfilesclient/spell.dbc`. 83 is `SPELL_EFFECT_DUEL`, and `StartDuel` finds the duel spell
   * by that effect rather than by a hardcoded id -- which is what the reference client does
   * (`samples/benilla/crates/benilla/src/ui_duel.rs:56-63`, byte-read from WoW.exe `0x4b2605`:
   * any learned spell whose `SpellRec+0xf4` is `0x53` is stored into the duel-spell global).
   */
  effect: 71,
  /** `EffectDieSides[0..2]`. With `effectBasePoints`, this is the min/max pair -- see `effectMin`. */
  effectDieSides: 74,
  /** `EffectRealPointsPerLevel[0..2]`, a FLOAT. The per-level growth term; 0 for most player spells. */
  effectRealPointsPerLevel: 77,
  /** `EffectBasePoints[0..2]`, SIGNED. Stores value-1: the minimum is `basePoints + 1`. See `effectMin`. */
  effectBasePoints: 80,
  /** `EffectRadiusIndex[0..2]` -> `SpellRadius.dbc`. `$a<n>`. */
  effectRadiusIndex: 92,
  /** `EffectAmplitude[0..2]`, MILLISECONDS between ticks of a periodic effect. `$t<n>`. */
  effectAmplitude: 98,
  /** `EffectChainTarget[0..2]`. `$x<n>`. */
  effectChainTargets: 104,
  /**
   * `EffectApplyAuraName[0..2]` -- the `AuraType` an `SPELL_EFFECT_APPLY_AURA` effect applies.
   *
   * Read for exactly one thing here: `SPELL_AURA_MOD_SHAPESHIFT` (36) is what makes a known spell a
   * STANCE, which is how `GetNumShapeshiftForms` is built (`ui/aura-bridge.ts`). The 36 is the same
   * `AuraType` vocabulary `network/game/object/combat-log.ts` already carries and labels.
   *
   * The INDEX is derived, not guessed, and it is checkable from the two neighbours already in this
   * table: `wow-data-parser/dbc/entities/spell.js:84` puts `effectAurasIDs` (3 columns) immediately
   * after `effectRadiusIDs` (3 columns, index 92 here) and immediately before `effectAmplitudes`
   * (index 98 here). 92 + 3 = 95 and 95 + 3 = 98, so 95 is the only value consistent with both.
   */
  effectApplyAuraName: 95,
  /**
   * `EffectMiscValue[0..2]` -- for a shapeshift effect, the `SpellShapeshiftForm.dbc` FORM id.
   *
   * SIGNED (`spell.js:89` reads `int32le`), and it must be: plenty of effects store a negative here.
   *
   * The index is derived the same way as `effectApplyAuraName`: `spell.js` runs
   * `effectItemTypes` (3) then `effectMiscValues` (**6** -- `EffectMiscValue[3]` and
   * `EffectMiscValueB[3]` in one array) then `effectTriggerSpells` (3) then
   * `effectPointsPerComboPoint`, which this table already fixes at 119. Walking back from 119:
   * 119 - 3 = 116 (`effectTriggerSpells`), 116 - 6 = **110**. `EffectMiscValueB` therefore starts at
   * 113, which is why only the first three columns are read.
   */
  effectMiscValue: 110,
  /** `EffectPointsPerComboPoint[0..2]`, a FLOAT. `$b<n>` -- Eviscerate's 5.0 per combo point. */
  effectPointsPerComboPoint: 119,
  /** `DurationIndex` -> `SpellDuration.dbc`. `$d`. */
  durationIndex: 40,
  /** `ProcChance`. `$h`. */
  procChance: 35,
  /** `StackAmount`. `$n`. */
  stackAmount: 49,
  /** `MaxAffectedTargets`. `$u`. */
  maxAffectedTargets: 212,
  /** `BaseLevel` and `MaxLevel`, the clamp either side of the per-level term. See `effectMin`. */
  baseLevel: 38,
  maxLevel: 37,
  /** `SchoolMask` -- which of the seven schools `$SP` should read. */
  schoolMask: 225,
  /**
   * `SpellDescriptionVariableID` -> `SpellDescriptionVariables.dbc`, where `$<mult>` and `$<percent>`
   * actually live. The LAST-but-one column, and the one that closes the 234 (see the file's tail
   * comment in `entities/spell.js`).
   */
  descriptionVariablesID: 232,
} as const;

/** The head of a `Spell.dbc` row -- only what a button, a cast and a tooltip line need. */
export interface SpellRow {
  id: number;
  name: string;
  /**
   * `NameSubtext` -- the rank label ("Rank 3", "Passive", or `''`). Never null; see `COL.nameSubtext`
   * for why the empty string rather than nil is the load-bearing case.
   */
  subName: string;
  /**
   * `Description` (column 170) -- the tooltip body, with the engine's `$` tokens UNEXPANDED. `''` for a
   * spell with none. See `COL.description`.
   */
  description: string;
  /** True when `Attributes` carries `SPELL_ATTR0_PASSIVE` (0x40) -- what `IsPassiveSpell` answers. */
  passive: boolean;
  /**
   * `Attributes` (column 4) bit **`0x80`** -- DO NOT DISPLAY. True for a spell the real client keeps OUT
   * of the spellbook, and this is the one filter that decides it.
   *
   * MEASURED across the whole served file (49,839 records, `fieldCount` 234, `recordSize` 936, byte
   * address `20 + record*936 + 16`); the bit is set on 10,243 spells, 20.6%. What the owner saw listed:
   *
   *     21184 Rogue Passive (DND)   0x000500d0   HIDE
   *       203 Unarmed               0x000000c0   HIDE
   *       204 Defense               0x000000c0   HIDE
   *      2567 Thrown                0x000000c0   HIDE
   *       202 Two-Handed Swords     0x000000c0   HIDE
   *       750 Plate Mail            0x000000c0   HIDE
   *       331 Healing Wave          0x00010000   show
   *       403 Lightning Bolt        0x00010000   show
   *       674 Dual Wield            0x00000050   show
   *      2764 Throw                 0x00410012   show
   *      3018 Shoot                 0x00400012   show
   *      6603 Auto Attack           0x00000010   show
   *
   * **It is NOT the `(DND)` NAME, and the name would have been wrong twice.** There is no spell called
   * `RoguePassive`: a raw scan of the 2.3 MB string block for that byte sequence returns ZERO hits, and the
   * spell is 21184 `"Rogue Passive (DND)"`, with a space. And of the 170 spells whose name ends in `(DND)`
   * only 97 carry the bit -- the other 73 have no `SkillLineAbility` row at all, so they are not learnable
   * and never reach a spellbook to be filtered.
   *
   * **It is NOT a `SkillLine` category either, and that hypothesis was tested and refuted.** The WEAPON
   * category is `SkillLine.dbc` col 1 == **6** (18 lines: Swords, Axes, Bows, ... 162 Unarmed, 176 Thrown,
   * ...), and `Unarmed` and `Throw` do both live there. But excluding category 6 would delete four things
   * the real client SHOWS: 674 `Dual Wield` is on category-6 line 118, and Dodge/Block/Parry are on
   * category-6 line 95. Measured over all 10,219 `SkillLineAbility` rows, 24 of the 32 category-6 spells
   * carry `0x80` and the 8 that do not are exactly Dodge, Block, Parry, Spirit Weapons, Dual Wield, Throw
   * and the two `Shoot` variants -- i.e. the bit separates them and the category cannot. (The
   * category-6 and category-7 spell sets are also DISJOINT, intersection 0, so nothing was leaking into
   * the class tabs by a bad join.)
   *
   * **`SkillLineAbility` carries no display flag**, also measured: 14 columns, of which `excludeRaces`(5),
   * `excludeClasses`(6) and both `characterPoints`(12,13) are entirely zero across all 10,219 rows, and
   * `AcquireMethod`(9) takes values 0/1/2 each of which contains both shown and hidden spells (Fireball
   * and Unarmed share `acq=2`).
   *
   * **It eats no real spell.** Of the 5,881 spells reachable through a category-7 class line, 2,257 carry
   * the bit and 2,215 of those are ALSO passive (0x40) -- talent ranks, which live in the talent frame and
   * never in the book. The remaining 42 are internal effect spells (`Vanished`, `Curse of Doom Effect`,
   * the `Metamorphosis` internals). No castable spellbook entry is in the set.
   *
   * One thing NOT sourced: the constant's NAME. 3.3.5a cores call this bit
   * `SPELL_ATTR0_DO_NOT_DISPLAY`/`SPELL_ATTR0_HIDDEN_CLIENTSIDE`, and that name is external knowledge --
   * the served file proves the DISCRIMINATION, which is all the filter needs.
   */
  hiddenInSpellbook: boolean;

  /**
   * Keep this spell's aura OFF every aura display -- a unit frame's buff row included, not just the
   * player's own bar.
   *
   * The owner found it on another player: "у него в бафах отображаются пасивные спасобности, что не
   * верно." He is right, and it also explains the "duplicated buffs" report before it -- weapon-skill
   * passives look alike and there are a lot of them.
   *
   * The reference's predicate verbatim: `attributes & ATTR_DO_NOT_DISPLAY != 0 || attributes_ex &
   * ATTR_EX_NO_AURA_ICON != 0` (`benilla-formats/src/spells/display.rs:617-619`), with
   * `ATTR_DO_NOT_DISPLAY = 0x80` and `ATTR_EX_NO_AURA_ICON = 0x1000_0000` (`spells/mod.rs:398,412`). It
   * is explicit that this is not a player-bar rule -- the aura is "hidden on *every* aura display, target
   * rows included" (`ui_aura.rs:36`), and the client's own gate for another unit's row is
   * `IsAuraDisplayable 0x519860`.
   *
   * **`0x80` IS THE SAME BIT `hiddenInSpellbook` READS**, which is not a coincidence to paper over: the
   * reference has one bit with two consumers, its spellbook predicate testing the identical
   * `ATTR_DO_NOT_DISPLAY`. So the measurement already recorded on that field -- 10,243 spells, 20.6%,
   * with `Unarmed`, `Defense`, `Thrown`, `Two-Handed Swords`, `Plate Mail` and `Rogue Passive (DND)` all
   * carrying it -- is the measurement behind this too, and it names exactly what the owner is seeing.
   *
   * NOT MODELLED, and declared: the reference also excludes TRACKING auras from every display
   * (`EffectApplyAuraName` in `{44, 45, 151}`), so `Find Minerals` never reaches a buff row and instead
   * feeds `GetTrackingTexture`. That needs the three effect-aura columns this file does not read, and it
   * is not the owner's symptom -- a tracking aura is on the PLAYER, not on another player's frame.
   */
  hiddenFromAuraBar: boolean;
  /** `SpellLevel`: which rank of a family this is. See `COL.spellLevel`. */
  spellLevel: number;
  iconID: number;
  /** `SpellVisual.dbc` id, or 0 for a spell with no visual (spell 6603 Auto Attack is one). */
  visualID: number;
  /** `SpellCastTimes.dbc` id. Read for a later round; cast TIME is deferred. */
  castingTimeIndex: number;
  /** `InterruptFlags`. Bit 0x1 = movement breaks the cast. See `COL.interruptFlags`. */
  interruptFlags: number;
  /** `ChannelInterruptFlags`. Bit 0x8 = movement breaks the channel. See `COL.channelInterruptFlags`. */
  channelInterruptFlags: number;
  powerType: number;
  manaCost: number;
  /** `Category`. 0 for a spell in no shared-cooldown group. */
  category: number;
  /** This spell's own cooldown, in MILLISECONDS. 0 for a spell with none. */
  recoveryTimeMs: number;
  /** The cooldown put on every spell sharing `category`, in milliseconds. */
  categoryRecoveryTimeMs: number;
  /** The GLOBAL COOLDOWN this spell triggers, in milliseconds. 0 for an off-GCD spell. */
  startRecoveryTimeMs: number;
  /** The GCD group. 133 is 3.3.5a's shared category; 0 means this spell triggers no GCD. */
  startRecoveryCategory: number;
  /** `SpellRange.dbc` id. */
  rangeIndex: number;
  /** Percent of BASE mana, used where `manaCost` is 0. See `spellCost` for why both are needed. */
  manaCostPercentage: number;

  /**
   * The three effects' columns, index 0 = effect 1. See `COL.effectDieSides` for where they come from
   * and `effectRange` for the min/max identity they define.
   */
  /**
   * `Effect[0..2]` -- each slot's `SPELL_EFFECT_*` id. See `COL.effect`; 83 is `SPELL_EFFECT_DUEL`,
   * which is how `StartDuel` finds the duel spell in the player's own book.
   */
  effect: number[];
  effectBasePoints: number[];
  effectDieSides: number[];
  effectRealPointsPerLevel: number[];
  effectPointsPerComboPoint: number[];
  effectRadiusIndex: number[];
  effectAmplitudeMs: number[];
  effectChainTargets: number[];
  /** `EffectApplyAuraName[0..2]`. 36 is `SPELL_AURA_MOD_SHAPESHIFT` -- see `COL.effectApplyAuraName`. */
  effectApplyAuraName: number[];
  /** `EffectMiscValue[0..2]`, SIGNED. The FORM id for a shapeshift effect. */
  effectMiscValue: number[];

  /** `DurationIndex` (`$d`), `ProcChance` (`$h`), `StackAmount` (`$n`), `MaxAffectedTargets` (`$u`). */
  durationIndex: number;
  procChance: number;
  stackAmount: number;
  maxAffectedTargets: number;

  /** The clamp either side of the per-level term. See `effectRange`. */
  baseLevel: number;
  maxLevel: number;

  /** `SchoolMask` -- which school's `GetSpellBonusDamage` `$SP` reads. */
  schoolMask: number;

  /** `SpellDescriptionVariableID`: 0, or a row of `SpellDescriptionVariables.dbc`. */
  descriptionVariablesID: number;
  /**
   * `DispelType` -- 1 Magic, 2 Curse, 3 Disease, 4 Poison, 0 none. See `COL.dispelType` for the DBC
   * that was read to establish those four, and `ui/aura-bridge.ts` for why anything else answers nil.
   */
  dispelType: number;
}

/**
 * The min and max an effect can roll, at a given caster level -- the identity every numeric token in a
 * description is built out of.
 *
 * ## The identity, and how it was checked
 *
 * `min = EffectBasePoints + 1` and `max = EffectBasePoints + EffectDieSides`. The column stores
 * value-1, which is why the `+1`. Verified against two spells whose real 3.3.5a tooltips the owner
 * himself photographed, both chosen because their `EffectRealPointsPerLevel` is **0**, so the level
 * term below cannot be hiding an error:
 *
 *     1752 Sinister Strike r1  effect 1 basePoints 2, dieSides 1  -> min 3, max 3
 *          description "An instant strike that causes $m1 damage ... Awards $s2 combo $lpoint:points;."
 *          effect 2 basePoints 0, dieSides 1 -> $s2 = 1, i.e. "3 damage ... Awards 1 combo point."
 *     2098 Eviscerate r1       effect 1 basePoints 0, dieSides 5, pointsPerComboPoint 5.0
 *          description "1 point: ${$m1+(($b1*1)+$AP*0.03)*$<mult>}-${$M1+(($b1*1)+$AP*0.07)*$<mult>}"
 *          -> m1 = 1, M1 = 5, b1 = 5, and with mult 1 and AP 0 that is **6-10 damage**, which is
 *          Eviscerate rank 1 at one combo point.
 *
 * Both fall out of the same two columns with no free parameter, which is the whole of the check: a
 * different reading (`basePoints` alone, or `basePoints + dieSides` as the single value) gets one of
 * the two wrong.
 *
 * ## The level term, and it is the part that is NOT verified here
 *
 * `level` is clamped into `[BaseLevel, MaxLevel]` (`MaxLevel = 0` meaning no cap), `SpellLevel` is
 * subtracted, and `RealPointsPerLevel` multiplies the remainder, truncated. That shape is
 * **TrinityCore 3.3.5's `SpellInfo::Effect::CalcValue`** -- a SERVER source, not a file in this repo
 * and not the client's own -- and nothing served here corroborates the choice of `SpellLevel` over
 * `BaseLevel` as the subtrahend, or truncation over rounding. It is labelled rather than hidden.
 *
 * What limits the damage: `RealPointsPerLevel` is 0 for the great majority of player abilities,
 * including BOTH spells above and every rogue ability in the owner's examples, so the term vanishes
 * and the identity that IS verified is what renders. Where it is non-zero (Fireball r1 carries 0.6
 * with `MaxLevel` 5) the number can be off by the truncation and the wrong-subtrahend risk, and that
 * is a known, stated limit rather than a silent one.
 */
export function effectRange(
  row: SpellRow,
  effectIndex: number,
  casterLevel: number,
): { min: number; max: number } {
  const basePoints = row.effectBasePoints[effectIndex] ?? 0;
  const dieSides = row.effectDieSides[effectIndex] ?? 0;
  const perLevel = row.effectRealPointsPerLevel[effectIndex] ?? 0;

  let level = casterLevel;
  if (row.maxLevel > 0 && level > row.maxLevel) {
    level = row.maxLevel;
  }
  if (level < row.baseLevel) {
    level = row.baseLevel;
  }
  const growth = Math.trunc((level - row.spellLevel) * perLevel);

  // `dieSides` 0 means the effect has no roll at all: min and max are both `basePoints + 1`, which is
  // what the stored value-1 encoding makes the single value. Folding 0 to 1 here rather than
  // special-casing keeps one expression for all three cases (0, 1, n).
  const sides = dieSides > 0 ? dieSides : 1;
  return { min: basePoints + growth + 1, max: basePoints + growth + sides };
}

/**
 * The client's literal missile-model fallback when a visual names a `SpellVisualEffectName` id that
 * does not resolve -- a checkerboard cube shipped in the real MPQs, and the reference's own note on it
 * is "faithful, not a joke" (`benilla-app/src/creature_anim/spell_visual.rs:27-29`, its `ERROR_CUBE`).
 *
 * Spelled with the DBC's own `.mdx`, exactly as the reference spells it, because it travels the same
 * route as every other path out of this module: `M2Blueprint.load` rewrites the extension and
 * `Loader#normalizePath` lowercases it. On this host `spells/errorcube.m2` answers 200 and its first
 * four bytes are `MD20`, so the fallback is a real model here and not a second dead end.
 */
const ERROR_CUBE_MODEL = 'Spells\\ErrorCube.mdx';

/**
 * THE THREE-WAY MISSILE FORK, as a pure function of the column value and a path lookup.
 *
 * Separated from `SpellData#missileModelPath` only so the decision can be asserted without loading
 * 49 MB of DBC -- the reference keeps a synthetic-table seam on its own catalog for the same reason
 * (`spell_visual/mod.rs:439-457`). There is one implementation and the method calls this.
 *
 * `effectId` is `SpellVisual` column 8 as stored, SIGNED, or `undefined` for a visual whose column is
 * zero. `pathOf` is `SpellData#effectModelPath`. See `missileModelPath` for every measured number.
 */
export function missileModelFrom(
  effectId: number | undefined,
  pathOf: (id: number) => string | null,
): string | null {
  // Below the gate -- including the 90 NEGATIVE rows -- means "this visual names no missile", which is
  // not the error case. Returning `ERROR_CUBE_MODEL` here would be the defect the column's own
  // docstring quantifies.
  if (effectId === undefined || !Number.isFinite(effectId) || effectId < 1) {
    return null;
  }
  return pathOf(effectId) ?? ERROR_CUBE_MODEL;
}

class SpellData {
  private spells: Map<number, SpellRow> | null = null;

  private icons: Map<number, string> | null = null;

  /** `SpellVisual.dbc` id -> its cast-stage kit id. */
  private castKits: Map<number, number> | null = null;

  /**
   * `SpellVisual.dbc` id -> its PRECAST-stage kit id -- the held pose, not the release.
   *
   * See `precastAnimation` for the measurement that establishes field 1 as the held pose and field 2 as
   * the release. This is a separate map rather than a second lookup on `castKits` because the two
   * columns answer two different questions at two different moments of one cast.
   */
  private precastKits: Map<number, number> | null = null;

  /** `SpellVisualKit.dbc` id -> its `animID`, sentinels already folded away. */
  private kitAnims: Map<number, number> | null = null;

  /**
   * `SpellVisualEffectName.dbc` id -> the effect model's path, EXACTLY AS THE DBC SPELLS IT.
   *
   * Not normalised and not extension-rewritten here, deliberately -- see `effectModelPath` for the
   * two places that already own those two jobs. 3964 of the table's 3965 rows carry a path; the one
   * that does not is id 3250 "Detect Invisibility and Stealth State", whose path column is the empty
   * string, and an empty path is dropped so it reads as absent rather than as a path to nowhere.
   */
  private effectPaths: Map<number, string> | null = null;

  /**
   * The `"HARDCODED *"` rows, LOWERCASED NAME -> path -- the engine-spawned effect set, which the
   * client resolves BY NAME once at boot rather than by id (a baked string table matched against the
   * name column, `spell_visual/mod.rs:53-58`). Lowercased because the client's matchers are
   * `stricmp`-family, which the reference notes at `mod.rs:691-693`.
   *
   * **16 rows on this build**, enumerated in `hardcodedEffectPath`. Nothing consumes them yet: they
   * are the corpse sparkle, the level-up ding, the mount poof and friends, none of which is wired.
   */
  private hardcodedEffects: Map<string, string> | null = null;

  /**
   * `SpellVisual.dbc` id -> its `missileModelID` (column 8), signed and non-zero only.
   *
   * Kept as the raw id rather than a resolved path so the `>= 1` gate and the ErrorCube fallback stay
   * in one expression in `missileModelPath`, where the reference puts them.
   */
  private missileModels: Map<number, number> | null = null;

  /** `SpellRange.dbc` id -> `maxRangeHostile`, in YARDS. What `IsActionInRange` is judged against. */
  private ranges: Map<number, number> | null = null;

  /** `SpellDuration.dbc` id -> `baseDuration` in MILLISECONDS. `$d`'s source. */
  private durations: Map<number, number> | null = null;

  /** `SpellRadius.dbc` id -> `radius` in YARDS. `$a<n>`'s source. */
  private radii: Map<number, number> | null = null;

  /**
   * `SpellDescriptionVariables.dbc` id -> its raw `Variables` string. **THIS IS WHERE `$<mult>` AND
   * `$<percent>` LIVE**, and neither is a constant to hard-code.
   *
   * The file is 2,787 bytes: **30 records, 2 fields, recordSize 8**, column 1 a `StringRef`
   * (`wow-data-parser/dbc/entities/spell-description-variables.js`), selected by `Spell.dbc` column
   * 232. Read off the served file, the two rows the owner's own examples select are:
   *
   *     id 169 (2098 Eviscerate)
   *       $mult1=$?s14162[${1.07}][${1.0}]
   *       $mult2=$?s14163[${1.14}][${$<mult1>}]
   *       $mult=$?s14164[${1.2}][${$<mult2>}]
   *     id 171 (1752 Sinister Strike)
   *       $aggression1=$?s18427[${103}][${100}]
   *       ... four more ...
   *       $percent=$?s61331[${115}][${$<aggression4>}]
   *
   * So both named variables are TALENT LADDERS: each line asks whether the player knows a talent spell
   * and falls back to the previous rung. With no talents, `$<mult>` is **1.0** and `$<percent>` is
   * **100** -- values that are computed from the served table and the player's own known-spell set, not
   * chosen. `spell-description.ts` evaluates them; see `$?s` there for the predicate.
   */
  private descVarRows: Map<number, string> | null = null;

  private pending: Promise<void> | null = null;

  /** True once every table is in memory and lookups can succeed. */
  get ready(): boolean {
    return this.spells !== null && this.icons !== null;
  }

  /**
   * Load all four tables, once. Idempotent and safe to call from every consumer -- callers that need a
   * value NOW read the accessors below, which answer null until this settles.
   */
  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Reset so a transient failure can be retried rather than poisoning the session for good; the
        // action bar simply stays iconless until then, which is the pre-existing state.
        this.pending = null;
        console.warn('spellData: load failed, action bar will stay iconless', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const startedAt = Date.now();
    // `SpellRange` rides with these four rather than getting a module of its own like
    // `shapeshift-data.ts` did, and the difference is which table its consumer needs FIRST: the bonus bar
    // must not wait on 49 MB because it decides which slots the buttons address, whereas a range check is
    // useless without `Spell.dbc`'s own `rangeIndex` anyway. It is 6 KB behind a fetch that is already
    // happening.
    // `SpellDuration` (2.1 KB), `SpellRadius` (0.9 KB) and `SpellDescriptionVariables` (2.8 KB) ride
    // along for the same reason `SpellRange` does: together they are under 6 KB behind a 49 MB fetch
    // that is already in flight, and none of them is useful without `Spell.dbc`'s own index columns.
    // `SpellVisualEffectName` (260 KB) rides along on the same argument the four small tables above
    // take: it is the only table that turns a visual's missile column into a model path, it is useless
    // without `SpellVisual` which is already being fetched, and 260 KB behind a 49 MB fetch that is
    // already in flight costs nothing measurable.
    const [spells, icons, visuals, kits, effectNames, ranges, durations, radii, descVars] = await Promise.all([
      this.loadSpells(),
      DBC.load('SpellIcon'),
      DBC.load('SpellVisual'),
      DBC.load('SpellVisualKit'),
      DBC.load('SpellVisualEffectName'),
      DBC.load('SpellRange'),
      DBC.load('SpellDuration'),
      DBC.load('SpellRadius'),
      DBC.load('SpellDescriptionVariables'),
    ]);

    this.durations = new Map<number, number>();
    for (const record of (durations as any).records ?? []) {
      // `baseDuration` is MILLISECONDS and is SIGNED -- **-1 means "no natural end"** (row 21 of the
      // served file), which `spell-description.ts#formatDuration` renders through the client's own
      // `SPELL_DURATION_UNTIL_CANCELLED`. `entities/spell-duration.js` carries the measurement and why
      // reading it unsigned printed "4294967.295 sec".
      //
      // `perLevel`/`maxDuration` are not read: the client's `$d` prints the base duration, and applying
      // a per-level term would be a guess at a formula nothing served states. Where the two differ the
      // printed number is the base one, and that is a stated limit -- 13 of the 130 rows have a base
      // above their own max.
      if (record && typeof record.baseDuration === 'number') {
        this.durations.set(record.id, record.baseDuration);
      }
    }

    this.radii = new Map<number, number>();
    for (const record of (radii as any).records ?? []) {
      if (record && typeof record.radius === 'number') {
        this.radii.set(record.id, record.radius);
      }
    }

    this.descVarRows = new Map<number, string>();
    for (const record of (descVars as any).records ?? []) {
      if (record && typeof record.variables === 'string' && record.variables !== '') {
        this.descVarRows.set(record.id, record.variables);
      }
    }

    this.ranges = new Map<number, number>();
    for (const record of (ranges as any).records ?? []) {
      // `maxRangeHostile` is the one a cast at an enemy is judged by; `maxRangeFriendly` differs only for
      // a handful of spells and the client uses the hostile value for the indicator. Both are YARDS, as
      // floats (`wow-data-parser/dbc/entities/spell-range.js`).
      if (record && typeof record.maxRangeHostile === 'number') {
        this.ranges.set(record.id, record.maxRangeHostile);
      }
    }

    this.spells = spells;

    this.icons = new Map<number, string>();
    for (const record of (icons as any).records ?? []) {
      if (record && typeof record.file === 'string' && record.file !== '') {
        this.icons.set(record.id, record.file);
      }
    }

    this.castKits = new Map<number, number>();
    this.precastKits = new Map<number, number>();
    for (const record of (visuals as any).records ?? []) {
      if (record && record.castKitID) {
        this.castKits.set(record.id, record.castKitID);
      }
      // ZERO is the only none-sentinel in this column, and that is MEASURED, not assumed: scanned across
      // all 9406 records of the served `spellvisual.dbc`, field 1 has 6592 zeros and field 2 has 4230, and
      // NEITHER column contains a single `0xFFFFFFFF` or any value at or above 2^31. The dual sentinel
      // benilla documents (`spell_visual/mod.rs:66-77`) is on `SpellVisualKit`'s own anim column, not here.
      // The `0xffffffff` test is kept as a cheap guard against a future file, and it is labelled as a guard
      // rather than as evidence -- an earlier draft of this comment claimed the form appears here, which it
      // does not.
      if (record && record.precastKitID && record.precastKitID !== 0xffffffff) {
        this.precastKits.set(record.id, record.precastKitID);
      }
    }

    this.kitAnims = new Map<number, number>();
    for (const record of (kits as any).records ?? []) {
      // THE DUAL NONE-SENTINEL. `0` and `0xFFFFFFFF` both mean "no animation" on this table, found
      // empirically by the reference across all 1772 kits (41 carry `0`, 875 carry `0xFFFFFFFF`) --
      // `samples/benilla/crates/benilla-formats/src/spell_visual/mod.rs:66-75`. Folding only one form
      // would make a kit resolve to animation id 4294967295, or worse to id 0 (`Stand`), which would
      // silently park a caster in an idle instead of playing nothing.
      const anim = record?.animID;
      if (typeof anim === 'number' && anim !== 0 && anim !== 0xffffffff) {
        this.kitAnims.set(record.id, anim);
      }
    }

    this.effectPaths = new Map<number, string>();
    this.hardcodedEffects = new Map<string, string>();
    for (const record of (effectNames as any).records ?? []) {
      const file = record?.file;
      if (typeof file !== 'string' || file === '') {
        continue;
      }
      this.effectPaths.set(record.id, file);
      // The engine-spawned set, keyed by name and not by id -- see `hardcodedEffects`. Only rows the
      // client's own boot name-resolve could hit, i.e. the `HARDCODED ` prefix.
      const name = record?.name;
      if (typeof name === 'string' && /^HARDCODED /i.test(name)) {
        this.hardcodedEffects.set(name.toLowerCase(), file);
      }
    }

    this.missileModels = new Map<number, number>();
    for (const record of (visuals as any).records ?? []) {
      // Stored when non-zero and left SIGNED. Zero is by far the common case -- 7554 of 9406 visuals
      // name no missile at all -- so skipping it keeps the map at the 1852 rows that say anything.
      const missile = record?.missileModelID;
      if (typeof missile === 'number' && missile !== 0) {
        this.missileModels.set(record.id, missile);
      }
    }

    spellWire.record({
      at: Date.now(),
      kind: 'TABLES_LOADED',
      spellId: 0,
      caster: null,
      detail: {
        spells: this.spells.size,
        icons: this.icons.size,
        castKits: this.castKits.size,
        precastKits: this.precastKits.size,
        kitAnims: this.kitAnims.size,
        effectPaths: this.effectPaths.size,
        hardcodedEffects: this.hardcodedEffects.size,
        missileModels: this.missileModels.size,
        ms: Date.now() - startedAt,
      },
      bodySize: 0,
      consumed: 0,
    });
  }

  /** The narrow `Spell.dbc` pass described in the header. */
  private async loadSpells(): Promise<Map<number, SpellRow>> {
    const raw = await new Loader().load('DBFilesClient\\Spell.dbc');
    const view = new DataView(raw);
    const bytes = new Uint8Array(raw);

    // WDBC header: signature, recordCount, fieldCount, recordSize, stringBlockSize.
    const recordCount = view.getUint32(4, true);
    const fieldCount = view.getUint32(8, true);
    const recordSize = view.getUint32(12, true);
    const HEADER = 20;
    const stringBlock = HEADER + recordCount * recordSize;

    // A definition that disagrees with the file is the failure mode `dbc/index.js#stridedRecord` exists
    // to contain, and here there is no entity to fall back on -- so refuse rather than read garbage.
    if (recordSize !== fieldCount * 4) {
      throw new Error(
        `Spell.dbc: recordSize ${recordSize} is not fieldCount ${fieldCount} * 4; column indices in `
          + 'spell-data.ts assume a uniform 4-byte column',
      );
    }
    if (fieldCount <= COL.name) {
      throw new Error(`Spell.dbc: only ${fieldCount} columns, expected more than ${COL.name}`);
    }

    const readString = (offset: number): string => {
      if (offset <= 0) {
        return '';
      }
      let end = stringBlock + offset;
      while (end < bytes.length && bytes[end] !== 0) {
        end += 1;
      }
      // The string block is UTF-8 in this build; `TextDecoder` is in every browser this client targets
      // and is already used elsewhere in the pipeline.
      return new TextDecoder().decode(bytes.subarray(stringBlock + offset, end));
    };

    const rows = new Map<number, SpellRow>();
    for (let i = 0; i < recordCount; i += 1) {
      const at = HEADER + i * recordSize;
      const col = (index: number) => view.getUint32(at + index * 4, true);
      // `EffectBasePoints` is SIGNED (a heal's cost effect and every debuff store negatives) and both
      // per-level columns are IEEE FLOATS -- reading either as a uint gives 1065353216 for 1.0.
      const int = (index: number) => view.getInt32(at + index * 4, true);
      const flt = (index: number) => view.getFloat32(at + index * 4, true);
      const three = (base: number, read: (i: number) => number) => [read(base), read(base + 1), read(base + 2)];
      const id = col(COL.id);
      if (id === 0) {
        continue;
      }
      rows.set(id, {
        id,
        name: readString(col(COL.name)),
        subName: readString(col(COL.nameSubtext)),
        description: readString(col(COL.description)),
        // `SPELL_ATTR0_PASSIVE`. See `COL.attributes` for the ten-sample measurement.
        passive: (col(COL.attributes) & 0x40) !== 0,
        // Bit 0x80 of the SAME word. See `SpellRow#hiddenInSpellbook` for the measurement that
        // establishes it and rules out both the `(DND)` name and the weapon skill CATEGORY.
        hiddenInSpellbook: (col(COL.attributes) & 0x80) !== 0,
        // The SAME `0x80`, plus `AttributesEx1`'s `0x1000_0000`. See `SpellRow#hiddenFromAuraBar` for the
        // reference's predicate and for why one bit legitimately has two consumers. `COL.attributes + 1`
        // is `AttributesEx1`: this file's own column note records that 4-11 are `Attributes` +
        // `AttributesEx1..Ex7`.
        hiddenFromAuraBar: (col(COL.attributes) & 0x80) !== 0
          || (col(COL.attributes + 1) & 0x10000000) !== 0,
        spellLevel: col(COL.spellLevel),
        iconID: col(COL.iconID),
        visualID: col(COL.visual),
        castingTimeIndex: col(COL.castingTimeIndex),
        interruptFlags: col(COL.interruptFlags),
        channelInterruptFlags: col(COL.channelInterruptFlags),
        powerType: col(COL.powerType),
        manaCost: col(COL.manaCost),
        category: col(COL.category),
        recoveryTimeMs: col(COL.recoveryTime),
        categoryRecoveryTimeMs: col(COL.categoryRecoveryTime),
        startRecoveryTimeMs: col(COL.startRecoveryTime),
        startRecoveryCategory: col(COL.startRecoveryCategory),
        rangeIndex: col(COL.rangeIndex),
        manaCostPercentage: col(COL.manaCostPercentage),

        // THE EFFECT BLOCK -- what every `$` token in a description resolves through. See
        // `COL.effectDieSides` for the indices and `effectRange` for what the first two mean.
        effect: three(COL.effect, col),
        effectBasePoints: three(COL.effectBasePoints, int),
        effectDieSides: three(COL.effectDieSides, int),
        effectRealPointsPerLevel: three(COL.effectRealPointsPerLevel, flt),
        effectPointsPerComboPoint: three(COL.effectPointsPerComboPoint, flt),
        effectRadiusIndex: three(COL.effectRadiusIndex, col),
        effectAmplitudeMs: three(COL.effectAmplitude, col),
        effectChainTargets: three(COL.effectChainTargets, col),
        effectApplyAuraName: three(COL.effectApplyAuraName, col),
        // SIGNED -- see `COL.effectMiscValue`.
        effectMiscValue: three(COL.effectMiscValue, int),
        durationIndex: col(COL.durationIndex),
        procChance: col(COL.procChance),
        stackAmount: col(COL.stackAmount),
        maxAffectedTargets: col(COL.maxAffectedTargets),
        baseLevel: col(COL.baseLevel),
        maxLevel: col(COL.maxLevel),
        schoolMask: col(COL.schoolMask),
        descriptionVariablesID: col(COL.descriptionVariablesID),
        dispelType: col(COL.dispelType),
      });
    }
    return rows;
  }

  // -- Lookups. Each answers null until `ensureLoaded` settles. ------------------------------------

  spell(spellId: number): SpellRow | null {
    return this.spells?.get(spellId) ?? null;
  }

  /**
   * The icon texture path for a spell, e.g. `Interface\Icons\Spell_Fire_FlameBolt`.
   *
   * Returned WITHOUT an extension, which is what `SpellIcon.dbc` stores and what the art layer wants:
   * `art.ts#load` appends `.blp` itself when a path carries no `.`.
   */
  /**
   * A spell's maximum range in YARDS, or null when it has none to check.
   *
   * Null for three distinct cases that all mean "no range indicator": the tables are not loaded, the
   * spell is unknown, or its range is 0 -- which is `SpellRange.dbc` id 1 ("Self Only") and id 2 ("Combat
   * Range", whose max is 0 because melee reach is computed from the two units' bounding radii and not
   * from this table). Melee therefore reports no range rather than a wrong one, which is correct
   * behaviour and not a gap: the real client shows no range dot on Heroic Strike either.
   */
  maxRange(spellId: number): number | null {
    const row = this.spell(spellId);
    if (row === null) {
      return null;
    }
    const yards = this.ranges?.get(row.rangeIndex) ?? null;
    return yards !== null && yards > 0 ? yards : null;
  }

  /** `SpellDuration.dbc` base duration in MILLISECONDS, or null. `$d`'s lookup. */
  durationMs(durationIndex: number): number | null {
    return durationIndex > 0 ? this.durations?.get(durationIndex) ?? null : null;
  }

  /** `SpellRadius.dbc` radius in YARDS, or null. `$a<n>`'s lookup. */
  radiusYards(radiusIndex: number): number | null {
    return radiusIndex > 0 ? this.radii?.get(radiusIndex) ?? null : null;
  }

  /** The raw `SpellDescriptionVariables.dbc` assignment block, or null. See the field's comment. */
  descriptionVariables(variablesId: number): string | null {
    return variablesId > 0 ? this.descVarRows?.get(variablesId) ?? null : null;
  }

  iconPath(spellId: number): string | null {
    const row = this.spell(spellId);
    if (row === null) {
      return null;
    }
    return this.icons?.get(row.iconID) ?? null;
  }

  /**
   * A `SpellIcon.dbc` id straight to its path, without going through a spell.
   *
   * Exists for the spellbook's TABS: a tab's art is `SkillLine.dbc`'s `spellIconID` (column 37, measured
   * -- `pipeline/dbc/skill-data.ts`), which is a `SpellIcon` id belonging to no spell, so `iconPath` has
   * no way to reach it.
   */
  icon(iconID: number): string | null {
    return this.icons?.get(iconID) ?? null;
  }

  /**
   * The `AnimationData.dbc` id the caster's body plays when this spell goes off, or null.
   *
   * The chain is the reference's (`benilla-formats/src/spell_visual/mod.rs`):
   * `Spell.dbc.visualIDs[0]` -> `SpellVisual.dbc.castKitID` -> `SpellVisualKit.dbc.animID`. Verified
   * end to end on the served 3.3.5a files against benilla's own byte-verified example -- spell 133
   * Fireball -> visual 67 -> cast kit 38 -> anim **53** (`SpellCastDirected`), which is exactly what
   * `spell_visual/mod.rs:78-79` records. Also checked: 585 Smite -> 128 / 119 -> 53, 2098 Eviscerate ->
   * 671 / 733 -> 57, 78 Heroic Strike -> 39 / 324 -> 57.
   *
   * Null is a real answer and not a failure: spell 6603 Auto Attack has `visualID = 0` and therefore no
   * kit and no anim, which is correct -- its animation comes from `SMSG_ATTACKERSTATEUPDATE`, one clip
   * per swing, which `network/game/object/combat.ts` already drives.
   */
  /**
   * `SpellVisualEffectName.dbc` id -> the effect model's path, **as the DBC spells it**, or null.
   *
   * ## Two things this deliberately does NOT do, because this client already has one place for each
   *
   * **It does not rewrite the extension.** The DBC names Warcraft III extensions and the asset host
   * serves none of them. Measured across the table's 2042 distinct non-empty paths: **1928 end `.mdx`,
   * 108 end `.mdl`, 6 already end `.m2`** -- and probing every one of them against the host with the
   * extension swapped to `.m2` answers **200 for 1936 of 2042 (94.8%)**. Probed as spelled, `.mdx` and
   * `.mdl` both 404: `spells/fireball_missile_low.mdx` 404s while `spells/fireball_missile_low.m2`
   * answers 200 and its first four bytes are `4d 44 32 30`, "MD20". So the rewrite is required -- and
   * `M2Blueprint.load` at `pipeline/m2/blueprint.js:29-30` already does exactly it, for both
   * extensions, for every model this client loads. A second rewrite here would be the duplicate-path
   * defect, so callers hand this string to `M2Blueprint.load` unchanged.
   *
   * **It does not lowercase or convert separators.** The host is case-sensitive and the DBC writes
   * mixed case with backslashes, so an un-normalised lookup 404s -- and a 404 returns an HTML page
   * which then fails to DECODE, naming the wrong subsystem twice. `Loader#normalizePath`
   * (`game/net/loader.js:15`) is the single place that does it, applied inside `Loader#url` so every
   * fetch gets it. `url` also runs `encodeURI`, which matters for the paths containing a SPACE: the
   * two in the sample (`World\Generic\Dwarf\Passive Doodads\...`) 404 unencoded and answer 200 encoded.
   *
   * ## The 106 that do not resolve
   *
   * The misses split almost entirely by original extension: **`.mdl` misses 90 of 108 (83.3%)** and
   * **`.mdx` misses 16 of 1928 (0.8%)**. The `.mdl` rows are a `Particles\` set this build no longer
   * ships -- dead alpha-era art still named in the table -- which is worth knowing before anyone reads
   * a missing model as a resolver bug. A 404 is NOT this function's business: it answers from the DBC
   * and the fetch is the caller's.
   */
  effectModelPath(effectId: number): string | null {
    if (!Number.isFinite(effectId) || effectId < 1) {
      return null;
    }
    return this.effectPaths?.get(effectId) ?? null;
  }

  /**
   * THE MISSILE MODEL for a `SpellVisual.dbc` id: `SpellVisual` column 8 -> `SpellVisualEffectName`
   * column 2 -> a model path. Null when the visual names no missile.
   *
   * ## Three outcomes, not two, and the boundary between them is the trap
   *
   * The reference's expression is `(missile_model >= 1).then(|| effect_path(id).unwrap_or(ERROR_CUBE))`
   * (`benilla-app/src/creature_anim/spell_visual.rs:952-957`), which forks three ways:
   *
   *  - **below 1 -> `null`.** The visual chain names no missile. This is NOT the error case and must
   *    not become one: the reference's own comment there says the spawner then falls back to the wire's
   *    ammo model, and every basic shot spell lands here. Measured on the served file: **7644 of 9406
   *    visuals** (7554 zero, **90 negative**).
   *  - **1 or above and the lookup succeeds -> that path.** Measured: **1760 visuals**. Fireball's
   *    visual 67 carries 365 -> `Spells\Fireball_Missile_Low.mdx`.
   *  - **1 or above and the lookup FAILS -> the literal `Spells\ErrorCube.mdx`.** The client's own
   *    fallback (`spell_visual.rs:27-29`). Measured: **2 visuals** -- visual 20 names effect 52 and
   *    visual 9240 names effect 3343, and neither row exists in the table.
   *
   * The trap is the boundary, and `missileModelID`'s own docstring carries the number: the column is
   * read as `int32` for this reason. Read as `uint32`, the 90 negative rows pass `>= 1`, fail the
   * lookup, and come out as ErrorCube -- turning a 2-visual error path into a 92-visual one, so one
   * visual in fifty would launch a checkerboard cube where the answer is "no missile".
   */
  missileModelPath(visualId: number): string | null {
    return missileModelFrom(
      this.missileModels?.get(visualId),
      (id) => this.effectModelPath(id),
    );
  }

  /**
   * One of the engine-spawned `"HARDCODED *"` effects, by name, case-insensitively. Null when the name
   * is not in the table.
   *
   * The client resolves this set by NAME at boot rather than by id (`spell_visual/mod.rs:53-58`), so
   * the name is the key here too. Nothing consumes it yet -- it is the half of the table the kit slots
   * never reach, and it is built now because it comes free with the load.
   *
   * **This build ships 16 such rows**, and all 16 are:
   *
   *     14    HARDCODED Loot Art                    Particles\LootFX.mdl
   *     21    HARDCODED Unit Level Up               Spells\LevelUp\LevelUp.mdl
   *     107   HARDCODED Breath Cold                 Particles\ColdBreath.mdl
   *     108   HARDCODED Breath Underwater           Particles\Bubbles.mdl
   *     200   HARDCODED Footstep Water Run Spray    Particles\FootstepSprayWater.mdl
   *     201   HARDCODED Footstep Water Walk Spray   Particles\FootstepSprayWaterWalk.mdl
   *     1185  HARDCODED Mount Poof                  spells\mountmorph_impact.mdx
   *     1223  HARDCODED Inebriated Bubbles          Spells\Bubble_Drunk.mdx
   *     1645  HARDCODED PetLoyalty Down Base        spells\loyaltydown_impact_base.mdx
   *     1646  HARDCODED PetLoyalty Down Head        spells\loyaltydown_impact_head.mdx
   *     1647  HARDCODED PetLoyalty Up Base          spells\loyaltyup_impact_base.mdx
   *     1648  HARDCODED PetLoyalty Up Head          spells\loyaltyup_impact_head.mdx
   *     2702  HARDCODED Meeting Stone Join          Spells\Bind_Impact_Base.mdx
   *     2922  HARDCODED Reputation                  Spells\ReputationLevelUp.mdx
   *     3207  HARDCODED Resist Spell                spells\resist_immune_effect.mdx
   *     4392  HARDCODED Achievement Base            spells\Achievement_OnRoot.mdx
   *
   * (`\` stands for a backslash throughout this block -- the DBC's own separator, which would end this
   * comment's escape rules if written literally.)
   *
   * **On "benilla has 14 and this build has 16": the two counts are not the same measurement, so the
   * difference cannot be reported as a list of two rows.** The reference's 14 is the size of the 1.12
   * CLIENT's baked string table at `0x61f5b0` -- the matcher's own name list -- while 16 is a row count
   * in this build's DBC. No 1.12 dump of this table is in this repo, so the 1.12 ROW count is not
   * measurable from here and no subtraction is claimed.
   *
   * What can be said from the data instead: id **4392 "HARDCODED Achievement Base"** cannot exist in
   * 1.12, because achievements shipped in 3.0.2. And the four **PetLoyalty** rows (1645-1648) are the
   * reverse case -- pet loyalty is a 1.12 mechanic that 3.0 removed, and its rows survive here with
   * their models still served. Both facts are about the FEATURES, not about the reference's table.
   *
   * `Particles\LootFX.mdl` and `Spells\LevelUp\LevelUp.mdl` both answer 200 as `.m2`; nine other
   * `Particles\*.mdl` rows in the sample do not, which is the `.mdl` attrition `effectModelPath`
   * records.
   */
  hardcodedEffectPath(name: string): string | null {
    if (typeof name !== 'string' || name === '') {
      return null;
    }
    return this.hardcodedEffects?.get(name.toLowerCase()) ?? null;
  }

  castAnimation(spellId: number): number | null {
    const row = this.spell(spellId);
    if (row === null || row.visualID === 0) {
      return null;
    }
    const kit = this.castKits?.get(row.visualID);
    if (!kit) {
      return null;
    }
    return this.kitAnims?.get(kit) ?? null;
  }

  /**
   * The `AnimationData.dbc` id the caster's body HOLDS for the duration of a cast, or null.
   *
   * `Spell.dbc.visualIDs[0]` -> `SpellVisual.dbc.`**`precastKitID`** (field 1) -> `SpellVisualKit.animID`.
   * The same chain `castAnimation` walks, one column to its left, and that column is the whole reason the
   * cast animation used to appear only at the END of a cast: field 2 is the RELEASE.
   *
   * ## WHICH FIELD IS WHICH, measured rather than assumed
   *
   * Read out of the served `dbfilesclient/spellvisual.dbc` (9406 records, fieldCount 32, recordSize 128)
   * joined to `spellvisualkit.dbc` (8663 / 38 / 152) and named through `animationdata.dbc` (506 rows).
   * Two independent facts settle it, and neither needs benilla's naming taken on trust:
   *
   * 1. **The animation NAMES the two columns resolve to are held poses on one side and discharges on the
   *    other.** The top eight of each, in order, with nothing omitted:
   *
   *        field 1  ReadySpellOmni 879, ReadySpellDirected 703, ReadyThrown 322, UseStandingLoop 188,
   *                 SpellCastOmni 39, SpellCastDirected 33, HoldRifle 33, HoldThrown 29
   *        field 2  SpellCastOmni 1091, SpellCastDirected 957, AttackThrown 517, ChannelCastDirected 131,
   *                 BattleRoar 112, AttackUnarmed 101, Special1H 76, SpecialUnarmed 76
   *
   *    **Field 1's 5th and 6th entries are NOT poses**, and they are listed rather than dropped -- an earlier
   *    draft of this comment stopped at the fourth entry, which is evidence with its counterexamples
   *    removed, the thing this project's rules forbid. Counted over the WHOLE table rather than the top
   *    eight, which is the honest form of the claim and is also much the stronger one:
   *
   *        field 1  2628 rows resolve to an anim: 2235 are Ready/Hold/Load/*Loop (85%),  84 are SpellCast*
   *        field 2  4173 rows resolve to an anim:   57 are Ready/Hold/Load/*Loop,      2120 are SpellCast*
   *
   *    So field 1 is 27x more likely to name a held pose than a `SpellCast*` clip and field 2 is 37x more
   *    likely to name the reverse. The 84 visuals that use a discharge clip as their wind-up do not weaken
   *    the reading -- a visual is free to do that -- and they are why this method has no fallback: what the
   *    kit names is what gets armed.
   * 2. **A spell that is INSTANT carries precast kit 0 and only a cast kit.** Measured: 78 Heroic Strike
   *    (visual 39) field 1 = 0, field 2 = kit 324 -> `Special1H`; 1752 Sinister Strike (253) field 1 = 0,
   *    field 2 = 399 -> `Attack1H`; 2098 Eviscerate (671) field 1 = 0, field 2 = 733 -> `Special1H`.
   *    An instant has no cast phase to hold and the table says so, which is why this method needs no
   *    special case for one -- it answers null and only the release plays.
   *
   * The timed spells on the test characters read, on the same files:
   *
   *     spell  133 Fireball      visual  67  precast kit  30 -> 51 ReadySpellDirected  cast kit  38 -> 53 SpellCastDirected
   *     spell  331 Healing Wave  visual  58  precast kit 100 -> 52 ReadySpellOmni      cast kit 183 -> 54 SpellCastOmni
   *     spell  403 Lightning Bolt visual 173 precast kit 124 -> 51 ReadySpellDirected  cast kit  72 -> 53 SpellCastDirected
   *     spell  585 Smite         visual 128  precast kit 184 -> 51 ReadySpellDirected  cast kit 119 -> 53 SpellCastDirected
   *     spell 2054 Heal          visual 135  precast kit  99 -> 52 ReadySpellOmni      cast kit 270 -> 54 SpellCastOmni
   *
   * So Healing Wave holds `ReadySpellOmni` for its 1.5 s and releases `SpellCastOmni` -- which is exactly
   * what the real client shows, and exactly what benilla's own byte-verified Fireball example ("precast
   * 30 / cast 38", `benilla-formats/src/spell_visual/mod.rs:78`) reads as on this build's file too.
   *
   * NOTE what is deliberately absent: there is NO fallback. `castAnimation`'s caller substitutes
   * `SpellCastDirected` for a spell whose chain yields nothing, because a cast with no visible release is
   * worse than a generic one; a HELD pose has the opposite trade. Parking a caster in a `ReadySpell` clip
   * a kit never asked for would freeze him there for the cast's whole length, and a frozen wrong pose is
   * more misleading than no pose at all.
   */
  precastAnimation(spellId: number): number | null {
    const row = this.spell(spellId);
    if (row === null || row.visualID === 0) {
      return null;
    }
    const kit = this.precastKits?.get(row.visualID);
    if (!kit) {
      return null;
    }
    return this.kitAnims?.get(kit) ?? null;
  }
}

export const spellData = new SpellData();

if (typeof window !== 'undefined') {
  (window as any).spellData = spellData;
}
