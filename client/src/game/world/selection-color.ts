/**
 * `CGUnit::GetSelectionCircleColor` -- the ONE selector both selection surfaces read.
 *
 * The reference states it byte-verified at `0x605960`, per-object vtable `+0x2c`
 * (`benilla/src/target/ring.rs:99-225`): the dword it returns is written verbatim as every ground-ring
 * decal vertex's diffuse, and the overhead name fetches the same slot. `ring.rs:137-145` records why
 * that matters here: benilla kept a duplicated mirror of the palette for the two surfaces, the ring
 * gained legs the name's copy did not, and a flagged player drew a green ring under a blue name. One
 * law, one function -- so `lua/api/units.ts#UnitSelectionColor` and `world/selection-ring.ts` both
 * come through this file.
 *
 * SCALE. The selector indexes the RAW reaction rank `0..7`. `world/faction.ts` answers `UnitReaction`'s
 * `1..8` scale, which is that rank plus one, so every threshold below is stated in the 1..8 scale the
 * rest of this client uses and the comment names the rank it corresponds to.
 *
 * NOT APPLIED, and each has a reason rather than an omission:
 *  - the PvP-flagged green and the party pale-blue/pale-green legs (`ring.rs:104-113`) need
 *    `UnitIsPVP` and a party roster, both declared gaps in this client;
 *  - the melee combat flash (`ring.rs:37-39`, the red<->orange pulse that outranks every branch);
 *  - the duel and free-for-all rungs of `UnitReaction` itself (`ring.rs:548-646`).
 */

/** An RGB triple in the 0..1 range. Alpha is never varied by this selector. */
export type SelectionRgb = readonly [number, number, number];

/** rank 0-1 -- `0xFFFF0000`. */
export const SELECTION_HOSTILE: SelectionRgb = [1, 0, 0];
/** rank 2 -- `0xFFFF8000`. */
export const SELECTION_UNFRIENDLY: SelectionRgb = [1, 0.502, 0];
/** rank 3 -- `0xFFFFFF00`. The owner's own reference crop of a Northshire wolf is this one. */
export const SELECTION_NEUTRAL: SelectionRgb = [1, 1, 0];
/** rank 4-7 -- `0xFF00FF00`. */
export const SELECTION_FRIENDLY: SelectionRgb = [0, 1, 0];
/** The player branch's unflagged, unpartied leg -- the pale `0xFF6060FF`, NOT the nameplate blue. */
export const SELECTION_PLAYER: SelectionRgb = [0.376, 0.376, 1];
/** A dead NPC -- mid-gray `0xFF7F7F7F`. Players skip the health check entirely. */
export const SELECTION_DEAD: SelectionRgb = [0.498, 0.498, 0.498];

/**
 * The selector, on `UnitReaction`'s 1..8 scale.
 *
 * Branch order is the binary's (`ring.rs:194-225`): **players first and they never check health**
 * (a dead player does not gray), hostile rank winning even for a player; then a dead NPC grays; then
 * the reaction palette.
 *
 * `dead` defaults false because the name-background caller must not apply the gray -- that is the
 * ground ring's rule and the frame takes its own tapped-gray branch (`targetframe.lua:262-264`)
 * without asking us.
 */
export function selectionColor(reaction: number, isPlayer: boolean, dead = false): SelectionRgb {
  // rank <= 1: the cross-faction attackability matrix, approximated as hostile red exactly as the
  // reference approximates it (`ring.rs:110-113`).
  if (reaction <= 2) {
    return SELECTION_HOSTILE;
  }
  if (isPlayer) {
    return SELECTION_PLAYER;
  }
  if (dead) {
    return SELECTION_DEAD;
  }
  if (reaction === 3) {
    return SELECTION_UNFRIENDLY;
  }
  if (reaction === 4) {
    return SELECTION_NEUTRAL;
  }
  return SELECTION_FRIENDLY;
}
