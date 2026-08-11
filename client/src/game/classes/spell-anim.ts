/**
 * The caster's own body clip for a spell going off -- and ONLY that.
 *
 * **Spell visual kits are out of scope for this round and nothing here draws one.** No particles, no
 * missile, no ground effect, no impact flash, no beam. What this file does is pick the
 * `AnimationData.dbc` id the CASTER's skeleton plays, which is a single field of the kit and the only
 * part of the visual system a character's own animation depends on.
 *
 * ## When it is armed
 *
 * At `SMSG_SPELL_GO`, not at `SMSG_SPELL_START`. That is the reference's own rule, byte-verified against
 * the client: "**`SpellCastOmni` (54) is armed at SPELL_GO**"
 * (`samples/benilla/crates/benilla/src/creature_anim/driver.rs:616`, and its test at
 * `driver/tests.rs:2454`). START is the wind-up and would be the cast BAR's event; GO is the release.
 *
 * ## Where the id comes from
 *
 * `Spell.dbc.visualIDs[0]` -> `SpellVisual.dbc.castKitID` -> `SpellVisualKit.dbc.animID`. Resolved by
 * `spellData.castAnimation` (`game/pipeline/dbc/spell-data.ts`), where the chain and its verification
 * against the served 3.3.5a files are recorded -- spell 133 Fireball resolves to anim **53**
 * (`SpellCastDirected`), which is exactly the value benilla's own byte-verified example gives.
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
