/**
 * The caster's own body clip for a spell going off -- and ONLY that.
 *
 * **Spell visual kits are out of scope for this round and nothing here draws one.** No particles, no
 * missile, no ground effect, no impact flash, no beam. What this file does is pick the
 * `AnimationData.dbc` id the CASTER's skeleton plays, which is a single field of the kit and the only
 * part of the visual system a character's own animation depends on.
 *
 * ## A CAST HAS TWO CLIPS, and for two rounds this file only played the second one
 *
 * The owner's report was "нет анимации во время каста, только финальная часть каста" -- nothing for 1.5 s
 * and then a release. That was correct and the cause was a column, not a timing bug. `SMSG_SPELL_GO` is
 * the END of a cast, and the only clip armed was the one `castKitID` names, so a 1.5 s Healing Wave stood
 * still and then discharged.
 *
 * The real client holds a pose and then releases, and `SpellVisual.dbc` carries both:
 *
 * - **`precastKitID` (field 1) is the HELD pose**, armed at `SMSG_SPELL_START`. For Healing Wave (331)
 *   it resolves to anim **52 `ReadySpellOmni`**.
 * - **`castKitID` (field 2) is the RELEASE**, armed at `SMSG_SPELL_GO` as it always was. For Healing Wave
 *   it resolves to anim **54 `SpellCastOmni`** -- which is why the reference's rule, "`SpellCastOmni` (54)
 *   is armed at SPELL_GO" (`samples/benilla/crates/benilla/src/creature_anim/driver.rs:616`, test at
 *   `driver/tests.rs:2454`), was right about the clip it names and was never a statement about the whole
 *   cast. **Its example is a mount summon**, and an earlier draft of this comment called it "a creature's
 *   instant", which is wrong: the mount-summon visuals whose cast kit is 1604/1607 are 1703/1706, and their
 *   PRECAST kit is 358 -> anim 123 `UseStandingLoop` -- a held pose. So the reference's own example has a
 *   precast stage too; it simply had no reason to arm it, because what it was modelling is the release.
 *
 * Which field is which is MEASURED off the served DBCs, not assumed -- the measurement, the anim-name
 * distribution across all 9406 visuals, and the five spells it was checked on are recorded on
 * `spellData.precastAnimation` (`game/pipeline/dbc/spell-data.ts`).
 *
 * **An instant spell shows only the release, and the DBC is what makes that automatic.** An instant sends
 * no `SMSG_SPELL_START`, so nothing arms a pose -- and independently its visual carries precast kit **0**
 * (78 Heroic Strike, 1752 Sinister Strike, 2098 Eviscerate all measured at 0), so even a START would
 * resolve to nothing. The two facts agree, which is the corroboration this project asks for.
 *
 * ## How the pose is HELD rather than played
 *
 * No new machinery. `ReadySpellOmni` is a looping sequence, and `Unit#externalSeq`'s latch "never releases"
 * a loop (see that field's own docstring) -- so arming it hands the body to the pose and locomotion stands
 * off until something else is armed. The release at GO is that something else: a one-shot, which the same
 * latch holds for its window and then gives back to locomotion. The blend layer (`InstanceAnim` keeps the
 * outgoing sequence alive for `blendTimeMs` and lerps per bone) makes both transitions a fade.
 *
 * The one thing the latch cannot do by itself is give the body back when a cast NEVER completes -- a looping
 * owner has no window to elapse. `SMSG_SPELL_FAILURE` and `SMSG_CAST_FAILED` therefore release it
 * explicitly, through `SpellHandler#releaseCastPose` (`network/game/object/spells.ts`), or an interrupted
 * caster would stand in his cast pose for the rest of the session. **That release is guarded twice** -- the
 * failing spell must be the one whose pose is in flight, AND the clip must still be the latched one -- and
 * self-review is what put both guards there: the first version released on the failing spell's DBC row
 * alone, which dropped a live pose whenever a SECOND spell was pressed mid-cast (every such press is refused
 * with `SMSG_CAST_FAILED`) and dropped a corpse's `DEATH` latch when a caster died mid-cast.
 *
 * ## The fallback, and why it is narrow
 *
 * A spell whose chain yields nothing -- no visual, no cast kit, or a kit whose `animID` is one of the two
 * none-sentinels -- gets `SpellCastDirected` (53) if the model owns it, and otherwise nothing. It is NOT
 * given `Stand`, and this is the same trap `combat.ts` documents for the defense reaction: `resolve`
 * falls back to the first inline sequence for any id a model does not own, so arming a clip a model lacks
 * would snap the caster into a one-frame Stand and back -- a flicker, not an animation. `resolve(id,
 * false)` withholds that consolation precisely so "absent" stays distinguishable from "present".
 *
 * ## SELF-REVIEW: THE PARAGRAPH ABOVE DESCRIBES AN INTENT THE CODE BELOW DOES NOT IMPLEMENT
 *
 * It used to end by citing spell 6603 "Auto Attack" as "the case that proves the null path is right
 * rather than a gap: it has `visualID = 0`, so it resolves to nothing here". **That sentence was
 * false.** `castAnimationFor` reaches the `owns(SPELL_CAST_DIRECTED)` leg for a chain that yields
 * nothing exactly as it does for a kit that named a clip the model lacks -- `spellData.castAnimation`
 * returns `null` for both and the two cannot be told apart here -- so a `visualID = 0` spell gets 53
 * `SpellCastDirected`, not nothing. 6603 is invisible only because melee auto-attack never reaches
 * this lane; `network/game/object/combat.ts` drives it off `SMSG_ATTACKERSTATEUPDATE`.
 *
 * IT IS VISIBLE ON THE WAND. Spell 5019 "Shoot" is a real cast that comes through here, and measured
 * on the served `spell.dbc` it carries **`visualID = 0`** -- as does 75 "Auto Shot". So neither ranged
 * auto-attack names any animation in the data at all, and the cast pose a wand user sees is this
 * fallback, not a kit. (`AnimationData.dbc` has no wand row either: 506 rows, and the ranged names are
 * ReadyBow 29 / AttackBow 46 / FireBow 47 / LoadBow 105 / LoadRifle 106 / LoadThrown 112 /
 * HoldThrown 111 -- nothing wand-specific.)
 *
 * The narrowing that would fix it is NOT a wand special case: split "the chain yielded nothing" from
 * "the kit named a clip this model lacks" and give the fallback only to the second, which is what the
 * paragraph above already claims it is for. It is left un-narrowed here because it is not a one-line
 * change to make safely -- measured on `spell.dbc` (49839 rows), **17100 spells carry `visualID = 0`
 * and 11686 more have a visual with no cast kit, so 28786 rows (58%) take the fallback today** against
 * 3218 whose kit exists but names a none-sentinel. Removing the release clip from 58% of the table on
 * the strength of one wand report is the kind of change that needs the owner's eye, so it is filed
 * rather than taken.
 *
 * And the real answer for a wand is a lane that does not exist here. The reference selects a ranged
 * auto-attack pose from the RANGED-slot item's `(class, subclass)`, byte-verified against the client's
 * `0x5fd460` -> LUT `0x5fd530` (`creature_anim/select.rs:573-593`): Bow -> LoadBow 105, Gun/Crossbow ->
 * LoadRifle 106, Thrown -> LoadThrown 112, **Wand -> HoldThrown 111**, anything else -> ReadyUnarmed 25,
 * with the promotion Load -> Hold at `select.rs:602-609` and "**Not** ReadyBow/AttackBow: no code in the
 * client plays those rows" stated in the same doc. `combat-anim.ts` ports the MELEE half of that file
 * (`swing_anim_main`, `select.rs:664-675`) and nothing of `ranged_load_anim`; grepping this tree for
 * `HoldThrown`, `LoadBow` or a ranged selector finds none. So the ranged auto-attack lane is ABSENT,
 * and that -- not this fallback -- is where a wand's pose belongs.
 */
import Unit from './unit';
import { spellData } from '../pipeline/dbc/spell-data';

/**
 * `AnimationData.dbc` id 53 `SpellCastDirected` -- the generic "cast something at a target" clip.
 *
 * Read out of the served `dbfilesclient/animationdata.dbc` rather than assumed: id 53 is
 * `SpellCastDirected` and 54 is `SpellCastOmni`, with 31 `SpellPrecast` and 32 `SpellCast` alongside.
 * Directed rather than Omni for the fallback because a spell cast from an action button is aimed at the
 * caster's selection; Omni is the "no direction" form.
 */
export const SPELL_CAST_DIRECTED = 53;

/**
 * The animation `unit` should play for `spellId`, or null when there is none it can play.
 *
 * Null is a real answer -- see the header on spell 6603 -- and the caller must treat it as "animate
 * nothing" rather than as a failure to substitute for.
 */
export function castAnimationFor(unit: Unit, spellId: number): number | null {
  const modelAnim = unit.model?.modelAnim ?? null;
  if (modelAnim === null) {
    return null;
  }
  // `resolve(id, false)` -- WITHOUT the Stand consolation. See the header.
  const owns = (id: number): boolean => modelAnim.resolve(id, false) !== null;

  const fromKit = spellData.castAnimation(spellId);
  if (fromKit !== null && owns(fromKit)) {
    return fromKit;
  }
  // The kit named a clip this model does not have, or named none at all. `SpellCastDirected` is the
  // generic stand-in, and it is still gated on the model owning it.
  if (owns(SPELL_CAST_DIRECTED)) {
    return SPELL_CAST_DIRECTED;
  }
  return null;
}

/**
 * The pose `unit` HOLDS while it casts `spellId`, or null when there is none it can hold.
 *
 * Null is the common and correct answer -- an instant's visual carries precast kit 0, and so do plenty of
 * timed spells' -- and the caller must arm nothing rather than substitute. See the header for why this
 * has no `SPELL_CAST_DIRECTED`-style fallback where `castAnimationFor` does: a wrong pose is held for the
 * whole cast, where a wrong release is over in a moment.
 */
export function precastAnimationFor(unit: Unit, spellId: number): number | null {
  const modelAnim = unit.model?.modelAnim ?? null;
  if (modelAnim === null) {
    // A KNOWN GAP, named rather than papered over: a caster whose M2 has not loaded yet gets NO pose, and
    // never gets one later either. `setAnimation` records `currentAnimationId` before its own model check
    // precisely so the model setter can replay a request that beat the load home (`unit.ts`), but this
    // returns null before `setAnimation` is ever called, so there is nothing to replay. It costs a peer his
    // cast pose during the ~9 s his model takes to arm after entry, which is the ordinary case for a peer
    // and never the case for the player, whose model is up long before he can press a button. Closing it
    // means deferring the KIT lookup rather than the arm, which is a bigger change than this round's.
    return null;
  }
  const fromKit = spellData.precastAnimation(spellId);
  if (fromKit === null) {
    return null;
  }
  // `resolve(id, false)` -- WITHOUT the Stand consolation, for the reason the header gives: `resolve`
  // falls back to the first inline sequence for an id a model lacks, and that sequence is normally a
  // LOOPING Stand. Latching the cast pose onto a looping Stand would freeze the unit for good, because
  // `externalSeq`'s release never fires for a loop.
  return modelAnim.resolve(fromKit, false) !== null ? fromKit : null;
}
