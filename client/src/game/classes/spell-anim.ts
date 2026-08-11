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
 *   cast. Its example is a creature's instant.
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
 * No new machinery. `ReadySpellOmni` is a looping sequence, and `Unit#externalSeq`'s latch "never
 * releases" a loop (`unit.ts:1590-1591`) -- so arming it hands the body to the pose and locomotion stands
 * off until something else is armed. The release at GO is that something else: a one-shot, which the same
 * latch holds for its window and then gives back to locomotion. The blend layer (`InstanceAnim` keeps the
 * outgoing sequence alive for `blendTimeMs` and lerps per bone) makes both transitions a fade.
 *
 * The one thing the latch cannot do by itself is give the body back when a cast NEVER completes -- a
 * looping owner has no window to elapse. `SMSG_SPELL_FAILURE` and `SMSG_CAST_FAILED` therefore call
 * `Unit#releaseAnimationLatch` explicitly (`network/game/object/spells.ts`), or an interrupted caster
 * would stand in his cast pose for the rest of the session.
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
 * Spell 6603 "Auto Attack" is the case that proves the null path is right rather than a gap: it has
 * `visualID = 0`, so it resolves to nothing here, and that is correct -- its animation is one swing clip
 * per `SMSG_ATTACKERSTATEUPDATE`, which `network/game/object/combat.ts` already drives.
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
