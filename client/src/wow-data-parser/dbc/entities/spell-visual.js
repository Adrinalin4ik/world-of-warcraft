import * as r from 'restructure';

import { Vec3Float } from '../../types';
import Entity from '../entity';

/**
 * `SpellVisual.dbc` -- the lifecycle STAGES and the missile block a spell's visual drives, keyed from
 * `Spell.dbc.visualIDs[0]` (column 131).
 *
 * The served 3.3.5a file measures `recordCount = 9406`, `fieldCount = 32`, `recordSize = 128`
 * (32 * 4, so every column is 4 bytes and a field index is its offset / 4). All 32 columns are now
 * declared, so `dbc/index.js#stridedRecord` has nothing left to re-seek past on this table.
 *
 * ## benilla is 1.12 and this layout SHIFTED -- every index here is measured, not ported
 *
 * `samples/benilla/crates/benilla-formats/src/spell_visual/mod.rs:9-27` documents the 1.12 build-5875
 * table as **16** fields and places channel at field 5, the missile gate at 6, the missile model at 7,
 * the dest-attach ordinal at 9, the flight sound at 10, the dest-anchored block at 11/12/13 and the
 * strike sound at 14. **On this build only fields 1-4 are still where benilla puts them.** 3.3.5a
 * inserts a column at index 5, so everything from channel onward moved by one, and then appends
 * sixteen further columns. Taking the reference's indices verbatim would have read the channel kit out
 * of a column that is populated on 7 of 9406 rows.
 *
 * Each column below carries its own measurement. The instruments were: (a) validating every non-zero
 * value against the id set of a candidate foreign table (`SpellVisualKit` 8663 rows,
 * `SpellVisualEffectName` 3965, `SoundEntries`, `AnimationData` 506, `SpellMissileMotion` 204,
 * `SpellEffectCameraShakes` 30); (b) splitting the 9406 visuals by a property of the SPELLS that reach
 * them through `Spell.dbc` column 131 and comparing how often a column is populated on each side; and
 * (c) benilla's own byte-verified anchor values, which reproduce on this file at the shifted indices.
 *
 * ## The anchors, re-verified here
 *
 * `Spell.dbc` column 131 gives Fireball 133 -> visual 67, Smite 585 -> 128, Heroic Strike 78 -> 39,
 * Healing Wave 331 -> 58. Visual 67's record reads in full:
 *
 *     67, 30, 38, 286, 0, 0, 0, 1, 365, 0, 1, 3011, 0, 1, 0, 0, -1, 100, 300, 750, 6, 0, ...
 *
 * -- precast 30 / cast 38 / impact 286, which are exactly benilla's three verified Fireball values
 * (`spell_visual/mod.rs:78`), and field 8 = 365, which resolves through `SpellVisualEffectName` to
 * `Spells\Fireball_Missile_Low.mdx`. A Fireball's missile model landing in that column is the
 * measurement; the name is not a guess.
 */
export default Entity({
  id: r.uint32le,

  /**
   * The HELD pose stage. 2814 rows populated, 99.8% of them a live `SpellVisualKit` id (the 7
   * exceptions are junk in the shipped table: rows 9687 and 10761/11487/11533/11547/12615/13525 carry
   * 1819239028 and 2718064, values far outside the kit table -- a data defect, not a decode error).
   * Fireball's 30 matches benilla. See `game/classes/spell-anim.ts` for why this stage exists.
   */
  precastKitID: r.uint32le,
  /** The RELEASE stage. 5176 rows, 100% kit-valid. Fireball's 38 matches benilla. */
  castKitID: r.uint32le,
  /** The impact stage. 4283 rows, 100% kit-valid. Fireball's 286 matches benilla. */
  impactKitID: r.uint32le,
  /**
   * The state stage. 3837 rows, 100% kit-valid. Measured NOT to be the channel column: it is
   * populated on 44.1% of visuals reached only by channelled spells and 40.8% of those reached only by
   * non-channelled ones -- no discrimination, which is what a stage that fires for both looks like.
   */
  stateKitID: r.uint32le,

  /**
   * **Unnamed on purpose.** This is the column 3.3.5a inserts ahead of benilla's channel field, and it
   * is populated on **7** of 9406 rows (5 distinct values, all valid kit ids). Seven rows support no
   * discriminator, so nothing here is evidence for a name and none is invented. Reserved so the
   * following indices stay correct.
   */
  unknownKitID: new r.Reserved(r.uint32le),

  /**
   * The channel stage -- benilla's field 5, measured here at **6**.
   *
   * The discriminator: split the visuals by whether the spells reaching them set a CHANNELED bit in
   * `Spell.dbc` `AttributesEx1` (column 5, mask 0x44 -- `SPELL_ATTR1_CHANNELED_1` 0x4 |
   * `SPELL_ATTR1_CHANNELED_2` 0x40). 891 visuals are reached only by channelled spells and 7428 only
   * by non-channelled ones. This column is populated on **86.6%** of the first group and **1.1%** of
   * the second -- a 79x ratio, and the only column in the record that behaves that way.
   */
  channelKitID: r.uint32le,

  /**
   * The missile gate. Takes only the values 0 and 1 across all 9406 rows (1803 ones), so it is a
   * boolean and not an id. Populated on 88.4% of visuals reached only by spells with `Spell.dbc`
   * `Speed` > 0 (column 47, independently confirmed here by Fireball reading 24.0) and on 1.5% of
   * those reached only by `Speed` == 0 spells.
   *
   * benilla warns that this is NOT the spawn gate -- the projectile exists whenever `Speed` > 0, and
   * this column's one reader there is the GO dest one-shot's suppressor
   * (`spell_visual/mod.rs`, `VisualStages::missile_gate`). Nothing in this client reads it yet.
   */
  hasMissile: r.uint32le,
  /**
   * The projectile's `SpellVisualEffectName` id -- benilla's field 7, measured here at **8**. 1852 of
   * 9406 rows are non-zero, of which **1762 are positive and 1760 of those (99.9%) name a live
   * `SpellVisualEffectName` row with a path**. Against the kit table only 32.1% would be valid, which
   * is what separates this column from every kit column in the record.
   * Fireball's 365 -> `Spells\Fireball_Missile_Low.mdx`.
   *
   * **SIGNED, and reading it unsigned inflates the error path 46-fold.** The reference gates the
   * missile on `field 7 >= 1` and treats anything below that as "this visual names no missile"
   * (`benilla-app/src/creature_anim/spell_visual.rs:952-957`). 90 of the non-zero rows here are
   * NEGATIVE. Read as `int32` they fall below the gate and correctly yield no missile; read as
   * `uint32` they become 4294967295-ish ids that pass `>= 1`, fail the effect-name lookup, and come
   * out the other side as the literal `Spells\ErrorCube.mdx`. Measured on the served file: the
   * genuine ErrorCube case is **2** visuals, and reading this column unsigned would make it **92**.
   */
  missileModelID: r.int32le,
  /**
   * 106 rows, and the only values are 1 and 2 -- a small enum, not an id. benilla records its 1.12
   * equivalent (its field 8) as "dead-by-absence" and no consumer here reads it either; it is named
   * only for its position, which the enum shape supports, and nothing further is claimed about it.
   */
  missilePathType: r.uint32le,
  /**
   * The destination-attachment ORDINAL -- an index into an attach-tag table, not an attachment id.
   * 13 distinct values including 0, distribution `{1: 6649, 0: 1975, 2: 657, 5: 42, 3: 35, 4: 29,
   * 6: 5, 10: 5, 13: 4, 14: 2, 12: 1, 15: 1, 19: 1}` -- small ordinals with 1 as the overwhelming
   * default, which is
   * why it is populated on 94.1% of missile visuals and still 74.9% of non-missile ones.
   *
   * benilla dumps the 1.12 table this indexes as `MISSILE_ATTACH_TABLE`, 11 live entries
   * (`spell_visual/mod.rs`). This build reaches ordinal 19, so **the table grew and its 3.3.5a
   * contents are NOT resolved here** -- the ordinal is read; the tag it maps to is still unknown.
   */
  missileDestinationAttachment: r.uint32le,
  /**
   * The in-flight loop sound -- benilla's field 10, measured here at **11**. 990 rows, **100%** of
   * them live `SoundEntries` ids, and populated on 39.5% of `Speed` > 0 visuals against 3.0% of
   * `Speed` == 0 ones. Fireball's is 3011.
   */
  missileSoundID: r.uint32le,
  /**
   * The `$TRD` anim-event sound -- the work/craft strike, benilla's field 14, measured here at **12**.
   * Only 47 rows, all 100% valid `SoundEntries` ids, and benilla's three named anchors reproduce
   * exactly at this column: Mining's visual 93 -> 1143 "Mining Impact", Herbalism's 91 -> 1142
   * "HerbalismSearch", the smithing crafts' 395 -> 1143 "Mining Impact".
   */
  animEventSoundID: r.uint32le,
  /**
   * A bitmask. 866 rows, 18 distinct values, and every one is a power of two or a sum of them:
   * `1, 2, 4, 5, 8, 32, 33, 36, 64, 72, 256, 257, ... 512`. No foreign table explains it (it scores
   * 100% "valid" against the kit ids only because the values are small), so the mask shape is the
   * whole of the evidence and no individual bit is named.
   */
  flags: r.uint32le,

  /**
   * **Two further impact-stage kit columns, deliberately not named individually.** 53 and 208 rows,
   * both 100% kit-valid. The kits they point at carry the same hit-reaction anim mix as
   * `impactKitID` does -- `CombatWound`, `CombatCritical`, `Knockdown` -- so both are impact-stage,
   * but nothing measured here says which one plays on the CASTER and which on the TARGET. The
   * wound-anim proportion differs (55% vs 67%) on samples of 11 and 58 kits, which is not evidence.
   * Exposing the pair as an array states exactly what was measured: these two columns are the block.
   */
  extraImpactKitIDs: new r.Array(r.uint32le, 2),

  /**
   * An M2 attachment id, signed, `-1` = none. This is the sparsest column in the record by a wide
   * margin -- **8184** of 9406 rows read `0xFFFFFFFF` -- with 1147 rows carrying 14 distinct values
   * from 0 to 40. A default of -1 rather than 0 is what marks it as an attachment id and not a
   * count or a flag.
   */
  missileAttachment: r.int32le,
  /**
   * **The four-column follow-ground block, not split.** Measured: 226 / 331 / 329 / 331 rows and
   * 16 / 8 / 11 / 8 distinct values, with maxima -100 (element 0 is signed), 4000, 50000 and 15.
   * Element 3's power-of-two-bounded max reads like a flag word and element 0's negative value like a
   * height offset, but the two middle columns are a speed and an approach distance in some order and
   * no measurement here separates them -- so the block is read as a block and no element is named.
   */
  missileFollowGround: new r.Array(r.int32le, 4),
  /**
   * `SpellMissileMotion.dbc` id -- the projectile's flight curve. 1051 rows and **99.9%** of them are
   * live `SpellMissileMotion` ids (204 rows in that table); resolved, the top values read "Parabola"
   * (255 visuals), "Parabola (High)" (64), "Forward Spin + Parabola" (61), "Parabola (Top Spin)" (32),
   * "Parabola (Low)" (31). Populated on 50.1% of `Speed` > 0 visuals against 2.1% of `Speed` == 0
   * ones. This table does not exist in 1.12 and benilla has no equivalent field.
   */
  missileMotionID: r.uint32le,

  /**
   * **Unnamed on purpose.** 17 rows, all valid kit ids, and no discriminator separates it from the
   * area-kit columns that follow. Reserved rather than guessed.
   */
  unknownKitID2: new r.Reserved(r.uint32le),
  /**
   * **Two further area-kit columns, deliberately not named individually.** 594 and 468 rows, both
   * 100% kit-valid. The persistent-area discriminator below leaves them flat -- 4.6%/6.8% and
   * 7.4%/5.0%, i.e. at the baseline -- so they are area-stage kits in some order and nothing measured
   * says which is which.
   */
  areaKitIDs: new r.Array(r.uint32le, 2),
  /**
   * The PERSISTENT area kit, and this one is pinned. 262 rows, 100% kit-valid. Split the visuals by
   * whether any of `Spell.dbc`'s three `effectIDs` (columns 71-73) is **27**
   * `SPELL_EFFECT_PERSISTENT_AREA_AURA`: 217 visuals are reached only by such spells and 8221 only by
   * others. This column is populated on **92.2%** of the first group and **0.3%** of the second -- a
   * 307x ratio, and the only one of the four area/kit columns in this tail that responds to the test
   * at all.
   */
  persistentAreaKitID: r.uint32le,

  /**
   * The record's last six columns are **two 3-float vectors** and that is measured, not assumed: they
   * are the only columns in the file whose non-zero values are 100% float-shaped (magnitudes between
   * 1e-3 and 1e4) and 0% valid as an id in any of the five candidate tables. They are populated on 31
   * and 39 rows.
   *
   * Which vector is the CAST offset and which the IMPACT offset is **not** pinned -- both belong to
   * the missile block and every discriminator tried (missile presence, impact-kit presence) populates
   * both together. So the pair is read as a pair.
   */
  missileOffsets: new r.Array(Vec3Float, 2)
});
