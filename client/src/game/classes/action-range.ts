import { SpellRow } from '../pipeline/dbc/spell-data';
import { isOnNextSwing } from './auto-attack-start';

/**
 * **IS THE ACTION IN RANGE? -- `IsActionInRange`'s tri-state answer.**
 *
 * The owner, with a screenshot of a warrior in melee range with rage to spare and Charge lit: "Я
 * стою вблизи, мне хватает ярости на charge, но charge нельзя использовать вблизи. Те же самые
 * условия могут быть и на другие способности, например у хантера."
 *
 * The bar showed Charge as usable while he was too close, because the old check tested only the
 * MAXIMUM range. Charge has a MINIMUM.
 *
 * ## THE TRI-STATE, AND WHY `0` IS THE ANSWER HERE AND NOT `nil`
 *
 * **This is the one predicate in the client where folding `0` to `nil` is the defect**, and it is
 * the exact inverse of the trap `CLAUDE.md` records three times ("`0` IS TRUTHY IN LUA, so an
 * engine global that means nothing must return nil"). Here `0` does not mean "nothing" -- it means
 * OUT OF RANGE, and the client's own Lua compares against it explicitly rather than testing
 * truthiness (`actionbutton.lua:467-484`, read from the served file):
 *
 *     local valid = IsActionInRange(self.action);
 *     if ( count:GetText() == RANGE_INDICATOR ) then
 *         if ( valid == 0 ) then      count:Show(); count:SetVertexColor(1.0, 0.1, 0.1);   -- RED
 *         elseif ( valid == 1 ) then  count:Show(); count:SetVertexColor(0.6, 0.6, 0.6);   -- grey
 *         else                        count:Hide();                                        -- nil
 *
 * So the three are distinct and each is reachable: `0` reddens, `1` greys, and only `nil` means
 * "range does not apply to this action". Returning `nil` for out-of-range leaves the hotkey grey --
 * which is exactly what he reports, a button that looks usable when it is not.
 *
 * ## THE FORMULA IS BYTE-VERIFIED, NOT INVENTED
 *
 * A port of the reference's `resolve_range` (`benilla-app/src/ui_action/state.rs:240-270`),
 * transcribing `GetMinMaxRange 0x6e3480` with its three constants (`state.rs:44-50`, wow-re
 * `wave-cooldown.md` + the decomp `FUN_006e3480`, VERIFIED), and the compare from
 * `IsTargetInRange 0x6e47b0` -- a SQUARED 3-D distance against min-squared / max-squared.
 *
 * Four arms, in the reference's own order:
 *
 *  1. **an ON-NEXT-SWING spell short-circuits to `(0, 100)`** -- the attribute test
 *     `SpellRec+0x18 & 0x404` at `0x6e34fb`, the same mask the melee queue reads
 *     (`auto-attack-start.ts#isOnNextSwing`). So Heroic Strike and Cleave report a flat 100-yard
 *     max and never redden, which is what the real client does.
 *  2. **a MELEE row** (`SpellRange.dbc` `flags & 1`) is `(0, max(selfReach + targetReach +
 *     MELEE_REACH_PAD, MELEE_RANGE_FLOOR))`. The 1.3333 pad is **melee-only** -- the reference is
 *     explicit that the ranged branch does not use it.
 *  3. **a row with min 0 AND max 0** is the Self row (id 1) -- no range to test, so `null`, and the
 *     hotkey hides.
 *  4. **everything else is the RANGED branch**: pad by the BARE reach sum, added to the max
 *     unconditionally but to the min **only when the row's min is already non-zero** (the decomp's
 *     `if (*min != 0.0)` guard). The reference states the consequence outright: "a min-0 spell
 *     (Fireball, Shadow Bolt) must never grow a min range, or point-blank casts refuse TOO_CLOSE."
 *
 * ## MEASURED on the served `dbfilesclient/spellrange.dbc` (64 records / 40 fields / 160 B)
 *
 * The 40-field width IS the 3.3.5a SPLIT row -- id, four floats, flags, then two localized string
 * blocks -- and `wow-data-parser/dbc/entities/spell-range.js` already declares it that way
 * (`minRangeHostile`, `minRangeFriendly`, `maxRangeHostile`, `maxRangeFriendly`), so the 1.12
 * min/max PAIR does not appear on this build and no 1.12 offset was carried over.
 *
 *     spell                                rangeIndex   min    max  flags  row name
 *     Charge 100, Intercept 20252               95     8.00  25.00    0    "Charge"
 *     Auto Shot 75, Arcane Shot 3044           114     0.00  35.00    2    "Hunter"
 *     Fireball 133                              35     0.00  35.00    0    "Medium-Long"
 *     Throw 2764                                74     0.00  30.00    2    "Ranged"
 *     Heroic Strike 78, Raptor Strike 2973       2     0.00   5.00    1    "Combat"
 *     (the self row)                             1     0.00   0.00    0    "Self"
 *
 * **Charge's minimum reads 8.00, and that is the number that proves the column.** A 1.12 offset
 * would have read it as 0 and the defect would have survived the fix. 23 of the 64 rows carry a
 * non-zero minimum, and id 2 is the ONLY row with `flags & 1`.
 *
 * A finding worth stating because it changes what the hunter half of his report means: **on 3.3.5a
 * the hunter rows have min 0** -- the vanilla dead zone is gone from the data. So a hunter ability
 * is never "too close" by this table; its shape is the MAX half, which is the same code and the
 * same fix.
 *
 * ## WHAT THE RANGE IS MEASURED BETWEEN
 *
 * Not centre-to-centre. Both reaches are added to the range, which is the reference's arrangement
 * and the reason a large mob is reachable at a greater centre distance. `UNIT_FIELD_COMBATREACH` is
 * already decoded on this client (`update-object/unit-fields.ts:87`), so this uses the real value.
 *
 * **NAMED GAP, with its size**: `UNIT_FIELD_BOUNDINGRADIUS` is NOT decoded here, and the reference
 * does not use it for this predicate either -- it pads with combat reach alone -- so nothing is
 * approximated by its absence. What IS approximated is a missing reach: `1.5` when a unit's own
 * value has not streamed yet, which is the reference's own fallback
 * (`ui_action/cast_target.rs:156, 199-204`). A player's real reach is near 1.5, so the error while
 * streaming is well under a yard on each side.
 */

/** `GetMinMaxRange 0x6e3480`'s melee-branch reach pad (`0x80b058`). MELEE ONLY. */
export const MELEE_REACH_PAD = 1.3333;

/** The melee branch's floor. */
export const MELEE_RANGE_FLOOR = 5.0;

/** The on-next-swing short-circuit's flat max. */
export const SELF_CAST_MAX = 100.0;

/** The fallback when a unit's `UNIT_FIELD_COMBATREACH` has not streamed. The reference's own. */
export const DEFAULT_COMBAT_REACH = 1.5;

/** One `SpellRange.dbc` row, as `spell-data.ts` stores it. */
export interface SpellRangeRow {
  min: number;
  max: number;
  /** `flags & 1` is the MELEE row -- id 2 "Combat", the only one on this build. */
  flags: number;
}

/**
 * The resolved min/max a press is judged against, or `null` for "range does not apply".
 *
 * `targetReach` is `null` when there is no target or its reach has not streamed -- the reference
 * returns the row unpadded in that case rather than guessing a pad.
 */
export function resolveRange(
  row: SpellRow,
  range: SpellRangeRow | null,
  selfReach: number,
  targetReach: number | null,
): { min: number; max: number } | null {
  // (1) The self-cast short-circuit's attribute test (`0x6e34fb`) -- the same `0x404` mask the
  // melee queue reads, tested here by the range law.
  if (isOnNextSwing(row)) {
    return { min: 0, max: SELF_CAST_MAX };
  }
  if (range === null) {
    return null;
  }
  // (2) The melee branch, and the 1.3333 pad belongs to it alone.
  if ((range.flags & 1) !== 0) {
    const reach = selfReach + (targetReach ?? DEFAULT_COMBAT_REACH) + MELEE_REACH_PAD;
    return { min: 0, max: Math.max(reach, MELEE_RANGE_FLOOR) };
  }
  // (3) The self row (id 1): nothing to test.
  if (range.min === 0 && range.max === 0) {
    return null;
  }
  // (4) The ranged branch. No target reach means no pad at all, not a guessed one.
  if (targetReach === null) {
    return { min: range.min, max: range.max };
  }
  const pad = selfReach + targetReach;
  // THE `min !== 0` GUARD IS LOAD-BEARING -- see arm 4 in the header. Growing a min-0 spell's
  // minimum would refuse Fireball at point-blank range.
  return {
    min: range.min === 0 ? 0 : range.min + pad,
    max: range.max + pad,
  };
}

/**
 * `IsActionInRange`'s answer for one action: `0` out of range, `1` in range, `null` not applicable.
 *
 * `distanceSq` is the SQUARED 3-D centre distance, which is what the reference compares
 * (`IsTargetInRange 0x6e47b0`'s squared min/max compare) -- no square root is taken.
 */
export function rangeState(
  row: SpellRow | null,
  range: SpellRangeRow | null,
  selfReach: number,
  targetReach: number | null,
  distanceSq: number | null,
): 0 | 1 | null {
  if (row === null) {
    return null;
  }
  const resolved = resolveRange(row, range, selfReach, targetReach);
  if (resolved === null || distanceSq === null) {
    // "Untestable inputs (no range row, unknown distance) pass" -- the reference's own rule, and
    // `null` rather than `1` so the hotkey HIDES instead of claiming a range it cannot judge.
    return null;
  }
  if (distanceSq > resolved.max * resolved.max) {
    return 0;
  }
  // A nonzero minimum is the TOO CLOSE case -- Charge's 8 yards, and the whole of the owner's report.
  if (resolved.min > 0 && distanceSq < resolved.min * resolved.min) {
    return 0;
  }
  return 1;
}
