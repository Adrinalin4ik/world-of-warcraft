import * as r from 'restructure';

import Entity from '../entity';

/**
 * `SpellVisualKit.dbc` -- one lifecycle stage's kit: the body animation the unit plays, the sound it
 * rings, the twelve attach-point / world effect-model slots, and the four `CharProc` slots that drive
 * the body's own render properties.
 *
 * The served 3.3.5a file measures `recordCount = 8663`, `fieldCount = 38`, `recordSize = 152`
 * (38 * 4). All 38 columns are now declared.
 *
 * ## benilla is 1.12 and this layout SHIFTED -- every index here is measured, not ported
 *
 * `samples/benilla/crates/benilla-formats/src/spell_visual/mod.rs:28-52` documents the 1.12 build-5875
 * table as **35** fields: anim at 2, **nine** emitter slots at 3-11, the world-plant slot at 12, the
 * sound at 13, a visual-group fallback at 14 and the four `CharProc` slots as five parallel 4-element
 * arrays starting at 15. 3.3.5a carries **eleven** emitter slots, not nine -- two extra sit between the
 * breath slot and the specials -- so everything from the world slot onward moved by **two**, and a
 * shake column and a flags column are new. Reading benilla's field 13 as the sound here would have
 * read a special-effect slot instead.
 *
 * ## How each index was pinned
 *
 * Two instruments. (a) Validating every non-zero value against a candidate foreign table's id set:
 * `AnimationData` (506 rows), `SpellVisualEffectName` (3965), `SoundEntries`,
 * `SpellEffectCameraShakes` (30). (b) For the emitter slots, resolving each column's values through
 * `SpellVisualEffectName` field 2 and reading the **model path filenames** -- the shipped art is named
 * by its attach point (`..._Head.mdx`, `..._Chest.mdx`, `..._Base.mdx`, `..._Hand.mdx`), so the
 * filename distribution per column is direct evidence for what the column attaches.
 *
 * That evidence is **dominance, not exclusivity**, and the comments below say so where it applies: a
 * suffix's share peaks sharply on one column but is never zero elsewhere, because the three "special"
 * slots are generic overflow and carry art of every kind.
 *
 * ## The anchors, re-verified here
 *
 * benilla's byte-verified Fireball chain (`spell_visual/mod.rs:78-81`) reproduces on this file:
 * kit 30 (precast) -> anim 51 `ReadySpellDirected`, sound 702 "Precast Fire Low"; kit 38 (cast) ->
 * anim **53** `SpellCastDirected`, sound **1484** "Fire Cast"; kit 286 (impact) -> anim **9**
 * `CombatWound`, sound **1507** "Molten Blast Impact". Both of benilla's sound values land at column
 * **15**, not its own 13.
 */
export default Entity({
  id: r.uint32le,

  /**
   * 87 rows carry a real value (100% of them live `AnimationData` ids, 40 distinct), 94 read `0` and
   * **8482** read `0xFFFFFFFF`. Named from benilla, which places it at the same index 1.
   */
  startAnimID: r.uint32le,
  /**
   * The `AnimationData.dbc` id this kit plays on the unit. 3462 rows carry a real value (100% of them
   * live `AnimationData` ids, 174 distinct, max 484). Fireball's cast kit 38 resolves to 53
   * `SpellCastDirected` and its impact kit 286 to 9 `CombatWound`, both benilla's verified values.
   *
   * **The none-sentinel is dual.** benilla found empirically (`spell_visual/mod.rs:66-76`) that "no
   * value" is written as EITHER `0` OR `0xFFFFFFFF`, inconsistently, and that holds on this build too
   * -- of the 5201 kits with no animation, **4874 carry the `-1` form and 327 carry `0`**. (benilla's
   * 1.12 counts are 875 and 41, so the split is this build's own measurement, not the reference's.)
   * Both must fold to "absent" or a kit with the `-1` form resolves to animation id 4294967295 and a
   * kit with the `0` form resolves to id 0 (`Stand`), which would silently park a caster in an idle.
   * `castAnimationFor` in `game/classes/spell-anim.ts` is the single place that folding happens.
   */
  animID: r.uint32le,

  /**
   * Head. 559 rows, 100% valid `SpellVisualEffectName` ids. `..._Head.mdx` is **42%** of this
   * column's resolved paths and at most 4% of any other slot's -- a 10x peak. Top entries:
   * `Sleep_State_Head.mdx`, `Ice_Precast_Uber_Head.mdx`, `StunSwirl_State_Head.mdx`.
   */
  headEffectID: r.uint32le,
  /**
   * Chest. 1599 rows, 100% effect-name-valid. `..._chest.mdx` is **44%** here against at most 13%
   * elsewhere. Top entries: `bloodbolt_chest.mdx`, `arcanepower_state_chest.mdx`, `Banish_Chest.mdx`.
   */
  chestEffectID: r.uint32le,
  /**
   * Base -- the unit's feet/ground. The most populated slot in the table at 2614 rows, 100%
   * effect-name-valid. `..._Base.mdx` is **36%** here; the only other column that comes close is
   * `worldEffectID` at 31%, which is the world-plant slot and is expected to carry ground art too.
   * Top entries: `Whirlwind_State_Base.mdx`, `FireNova_Area.mdx`, `DustCloud_Land.mdx`.
   */
  baseEffectID: r.uint32le,
  /**
   * **The two hand slots, deliberately not split into left and right.** 1143 and 1158 rows, 100% and
   * 99.8% effect-name-valid, and their contents are near-identical -- `..._Hand.mdx` is 68% and 67%
   * of the two columns (the highest share of any pair in the record) and the top four models are the
   * same art in nearly the same counts (`Shadow_Precast_Uber_Hand.mdx` 96 vs 90,
   * `Fire_Precast_Hand.mdx` 69 vs 62, `Lightning_Cast_Hand.mdx` 59 vs 57).
   *
   * That symmetry is exactly what evidences them as a hand PAIR and exactly why it cannot say which
   * is the left. benilla's 1.12 order is left then right (`KIT_SLOT_TAGS`, `LeftHand` 0x15 before
   * `RightHand` 0x16), but that is the reference's byte order for a 9-slot table and this is an
   * 11-slot one, so it is not carried over as a claim.
   */
  handEffectIDs: new r.Array(r.uint32le, 2),
  /**
   * Breath. Only 342 rows, 99.7% effect-name-valid, and the `breath` name pattern is **33%** of this
   * column against 1-4% of every body slot before it. Top entries: `acidliquidbreath.mdx`,
   * `FlameBreath.mdx`. (The special slot at index 0 also reads 31% breath -- generic overflow -- which
   * is why this is stated as dominance over the body slots rather than exclusivity.)
   */
  breathEffectID: r.uint32le,
  /**
   * **The two weapon slots, deliberately not split into left and right.** The two columns 3.3.5a adds
   * that 1.12 does not have. Very sparse -- 24 and 77 rows -- and 96-100% effect-name-valid. What
   * evidences them as WEAPON slots is not a filename suffix but the class of art: these are the only
   * columns whose contents are HELD OBJECTS rather than body VFX -- `SpellObject_Wrench.mdx`,
   * `TankardA_SpellObject.mdx`, `TorchSpell.mdx`, and eight rows each of
   * `firearm_2h_rifle_a_06.mdx` and `firearm_2h_rifle_01_spellobject.mdx`.
   *
   * Which is the left is not pinned. A gun is a two-handed ranged weapon and does not discriminate.
   */
  weaponEffectIDs: new r.Array(r.uint32le, 2),
  /**
   * The three generic "special" slots. 74 / 16 / 7 rows, 97-100% effect-name-valid, and they carry art
   * of every kind -- hand models (44%, 69%, 86%), breath, chest, head -- which is what marks them as
   * overflow rather than a named attach point, and is the reason every suffix claim above is stated as
   * dominance. benilla names its three equivalents Special1-3 (`KIT_SLOT_TAGS` 0x17-0x19).
   */
  specialEffectIDs: new r.Array(r.uint32le, 3),

  /**
   * The world/ground PLANT slot -- benilla's field 12, measured here at **14**. 869 rows, 100%
   * effect-name-valid.
   *
   * **All four of benilla's named anchors for this column reproduce exactly here** (its module doc
   * lists them as the shipped population that proves the slot is body/ground state models and never
   * projectiles): kit 285 -> `Spells\Frost_Nova_state.mdx`, kit 744 -> `Spells\Net_State.mdx`,
   * kit 66 -> `Spells\EntanglingRoots_State.mdx`, kit 746 -> `Spells\Web_State.mdx`. Four for four at
   * index 14 is what pins the +2 shift on this half of the record. The column's own top entries are
   * ground rings -- `ThunderClap_Cast_Base.mdx`, `dustnova_cast_base.mdx`, `FireNova_Area.mdx` --
   * which is why `..._Base.mdx` peaks here as well as on `baseEffectID`.
   *
   * benilla byte-pins the placement (`spell_visual/mod.rs`, `WORLD_EFFECT_TAG`): no bone, a one-time
   * world plant at the owner's position/facing/scale, baked at spawn. Three of the caster-feet kit ids
   * benilla names for 1.12 (349, 420, 389) read **0** in this column on 3.3.5a, so that part of the
   * population moved between builds and is not claimed here.
   */
  worldEffectID: r.uint32le,
  /**
   * The `SoundEntries.dbc` id this stage rings -- benilla's field 13, measured here at **15**. 4680
   * rows, **99.4%** of them live `SoundEntries` ids (913 distinct, max 18018 -- far outside every
   * other candidate table's id space). Both of benilla's verified Fireball sound values land here: kit 38 -> 1484
   * "Fire Cast", kit 286 -> 1507 "Molten Blast Impact".
   *
   * benilla reports the dual none-sentinel on this column too, on a handful of rows; here 3968 silent
   * kits write `0` and **15** write `0xFFFFFFFF`. A consumer must fold both forms, as `animID`'s does.
   */
  soundID: r.uint32le,
  /**
   * `SpellEffectCameraShakes.dbc` id -- the camera kick. 336 rows and **100%** of them are live ids in
   * that table, which has only **30** rows; a column scoring 100% against a 30-row id space is about
   * as tight as this instrument gets. 28 distinct values, max 92. New in 3.3.5a: benilla has no
   * equivalent field, and `dbc/entities/spell-effect-camera-shakes.js` is the table it keys.
   */
  shakeID: r.uint32le,

  /**
   * The four `CharProc` slots' dispatch keys -- benilla's fields 15-18, measured here at **17-20**.
   * Signed: an empty slot is `-1`, and **`0` is a real key** (benilla's `CHAIN_CHANNEL`), so the
   * populated count is rows that are not `-1`: **1473 / 132 / 14 / 5**. Slots 2 and 3 are all but
   * unused, which matches benilla's account of the shipped data.
   *
   * The full key set observed across the four columns is
   * `0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17` -- 17 keys, where benilla's dispatcher
   * has 9 cases, so this build reaches keys the reference does not model. Every key benilla DOES name
   * is present: `CHAIN_CHANNEL` 0, `TINT` 1, `ANIM_RATE` 11, `CHAIN_CAST` 12, `ALPHA` 14, plus the
   * dynobject emitter's 9. The type semantics are benilla's `char_proc_type` module's; nothing here
   * reads them yet.
   */
  charProcTypes: new r.Array(r.int32le, 4),
  /**
   * `CharParamZero[4]` -- benilla's fields 19-22, measured here at **21-24**. Float columns.
   *
   * The five param blocks are **parallel arrays**, one element per `CharProc` slot, not four
   * contiguous per-slot records -- so slot `i`'s four params are `charParamZero[i]`,
   * `charParamOne[i]`, `charParamTwo[i]`, `charParamThree[i]`. That transposition is measured, and it
   * is the one thing about this block that a wrong guess would silently scramble: taking the 1354 rows
   * where only type-slot 0 is filled, the non-zero param columns are 21 (1268 rows), 25 (603), 29
   * (843) and 33 (603) -- i.e. element 0 of each of the four blocks, exactly as parallel arrays
   * predict, and not columns 21/22/23/24.
   *
   * **Two of benilla's own param values reproduce here at column 22**, which pins the block start as
   * well as the transposition: kit 1744 has types `[1, 11, -1, -1]` and `charParamZero = [4144959.0,
   * 8947848.0, 0, 0]`, so its `ANIM_RATE` (type 11, slot 1) param is **8947848.0 = 0x888888** --
   * benilla's exact documented oddity for that kit; and kit 3709 Ice Block has the same type pair with
   * slot 1's param **0.0**, benilla's documented rate-zero freeze.
   *
   * Integer-valued params are stored in these float columns and read back through the client's
   * small-int decode, `bits(param + 512.0) >> 14 & 0xff` (benilla `char_proc_small_int`). Nothing here
   * decodes them yet.
   */
  charParamZero: new r.Array(r.floatle, 4),
  /** `CharParamOne[4]` -- measured at **25-28**. See `charParamZero` for the transposition evidence. */
  charParamOne: new r.Array(r.floatle, 4),
  /** `CharParamTwo[4]` -- measured at **29-32**. See `charParamZero`. */
  charParamTwo: new r.Array(r.floatle, 4),
  /** `CharParamThree[4]` -- measured at **33-36**. See `charParamZero`. */
  charParamThree: new r.Array(r.floatle, 4),

  /**
   * A bitmask, and the last column in the record. 192 rows, 15 distinct values, all powers of two or
   * sums of them: `1, 2, 3, 4, 32, 64, 256, ... 1536`. No foreign table explains it and no individual
   * bit is named. New in 3.3.5a; benilla's 35-field table ends before it.
   */
  flags: r.uint32le
});
