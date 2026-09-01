/**
 * THE ONE DOOR from a press to `CMSG_CAST_SPELL`, and the red line when the press is refused.
 *
 * Four bridges send casts -- the action bar, the spellbook, the shapeshift bar and the duel accept --
 * and the in-flight guard's two arms have to behave identically at all four. The reference states that
 * as a rule rather than a preference: "ONE cast-send path, so the follow-through can't drift between
 * the two spell sources (the root-cause rule: never duplicate a send path)"
 * (`samples/benilla/crates/benilla-app/src/ui_action/cast_send.rs:216-218`).
 *
 * ## The two arms are DIFFERENT, and the silent one is not an omission
 *
 * `SpellHandler#castSpell` decides and returns which case it is; this turns that into what the player
 * sees (`ui_action/cast_send.rs:283-297`, the real client's `TryCast 0x6e4b60`):
 *
 *  - **the same spell again -- SILENT.** No packet and no message: the client bails at `6e4d43` without
 *    reaching its error path at all. This is the owner's case ("Каст способностей не должен прерываться
 *    повторным нажатием") and the correct answer is that nothing at all happens.
 *  - **a different spell -- the red line.** Reason 0x61, whose string is
 *    `SPELL_FAILED_SPELL_IN_PROGRESS`, and no packet either (`6e4d97`).
 *
 * So this is the one place in the cast path where a `notImplemented`-style notice would be WRONG for
 * one arm and required for the other, which is why the fork lives here and not in the caller.
 *
 * ## The string is read from the client's own globals, never spelled in English here
 *
 * `GlobalStrings.lua:7160` defines `SPELL_FAILED_SPELL_IN_PROGRESS = "Another action is in progress"` --
 * in the enUS file. **The owner plays a ruRU client**, so hardcoding the English sentence would put an
 * English line on a Russian screen. `vm.getGlobal` reads whatever locale's `GlobalStrings.lua` the
 * runtime actually loaded, which is the same thing `container-bridge.ts#equipErrorText` does for the
 * equip errors and for the same reason.
 *
 * The engine's whole job is the event and its text: `UIErrorsFrame_OnLoad` registers `UI_ERROR_MESSAGE`
 * and its handler is one line, `self:AddMessage(arg1, 1.0, 0.1, 0.1, 1.0)` (`uierrorsframe.lua:14-15`),
 * so the colour, the position and the hold are all the document's.
 */
import type { SpellHandler } from '../../network/game/object/spells';
import { LuaVM } from './framexml/lua/vm';
import { fireEvent } from './framexml/lua/events';

/**
 * Cast `spellId` at `target`, and put the client's own refusal on screen when a cast is already running.
 *
 * Returns what `castSpell` decided, so a caller that wants to skip its own follow-through (a cooldown
 * push, a checked-ring update) on a refused press can.
 */
export default function castWithRefusal(
  vm: LuaVM,
  spells: SpellHandler,
  spellId: number,
  target: string | null,
): 'sent' | 'busy-same' | 'busy-other' {
  const verdict = spells.castSpell(spellId, target);
  if (verdict === 'busy-other') {
    // A missing string fires nothing rather than an empty red line -- the same rule
    // `container-bridge.ts` states for a reason byte `GlobalStrings.lua` does not name.
    const text = vm.getGlobal('SPELL_FAILED_SPELL_IN_PROGRESS');
    if (typeof text === 'string' && text !== '') {
      fireEvent(vm, 'UI_ERROR_MESSAGE', [text]);
    }
  }
  return verdict;
}
