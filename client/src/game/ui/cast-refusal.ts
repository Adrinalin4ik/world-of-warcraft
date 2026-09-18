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
import { ERR_INVALID_TARGET, ERR_NO_TARGET } from '../classes/cast-target';
import { LuaVM } from './framexml/lua/vm';
import { cvarBool } from './framexml/lua/api/screen';
import { fireEvent } from './framexml/lua/events';

/**
 * **THE `autoSelfCast` CVAR -- a real knob of the real client, seeded ON here.**
 *
 * The reference records the engine's own registered default as `"0"` (name `0x870dc0`, gate
 * `[0xceac34]+0x28` at `0x6e53d7`) and then **defaults it ON anyway**, as a named deviation, because
 * with it off an unbindable friendly cast falls into the targeting-cursor machine it does not model
 * (`ui_action/cast_target.rs:211-222`). This client is in exactly that position -- see
 * `classes/cast-target.ts` on the cursor -- and the owner asked for the fallback in as many words:
 * "должен мочь и такие эффекты должны автоматически применяться на меня".
 *
 * So the default deviates from the shipped `"0"` on the owner's requirement, the same standing
 * `lockActionBars` and the two nameplate CVars already take in `api/screen.ts`. It is a REAL CVar,
 * so the client's own options panel or a `SetCVar("autoSelfCast", "0")` turns it off with no code
 * change -- which is the whole reason it is a CVar here rather than a constant.
 */
const AUTO_SELF_CAST_CVAR = 'autoSelfCast';

/** Which `GlobalStrings.lua` name each local refusal shows. See `classes/cast-target.ts`. */
const REFUSAL_STRING: Record<string, string> = {
  'busy-other': 'SPELL_FAILED_SPELL_IN_PROGRESS',
  'no-target': ERR_NO_TARGET,
  'invalid-target': ERR_INVALID_TARGET,
};

/**
 * Cast `spellId` at `target`, and put the client's own refusal on screen when the press is refused.
 *
 * Returns what `castSpell` decided, so a caller that wants to skip its own follow-through (a cooldown
 * push, a checked-ring update) on a refused press can.
 *
 * ## Three refusal reasons now, not one -- and the ORIGINAL RULE IS UNCHANGED
 *
 * The in-flight fork above is untouched: the same spell again is still **silent**, a different spell
 * still shows `SPELL_FAILED_SPELL_IN_PROGRESS`, and neither sends a packet. What is added is the
 * TARGET-resolution refusal, which is a different refusal at a different moment -- the press was not
 * refused because something is already casting, it was refused because nothing bindable could be
 * found for the spell's own targeting word (`classes/cast-target.ts`).
 *
 * It joins here rather than anywhere else for this module's own stated reason: four bridges send
 * casts and all four must behave identically, so a second refusal surface would be the drift this
 * file exists to prevent.
 */
export default function castWithRefusal(
  vm: LuaVM,
  spells: SpellHandler,
  spellId: number,
  target: string | null,
): 'sent' | 'busy-same' | 'busy-other' | 'no-target' | 'invalid-target' {
  const verdict = spells.castSpell(spellId, target, cvarBool(vm, AUTO_SELF_CAST_CVAR));
  const name = REFUSAL_STRING[verdict];
  if (name !== undefined) {
    // A missing string fires nothing rather than an empty red line -- the same rule
    // `container-bridge.ts` states for a reason byte `GlobalStrings.lua` does not name.
    const text = vm.getGlobal(name);
    if (typeof text === 'string' && text !== '') {
      fireEvent(vm, 'UI_ERROR_MESSAGE', [text]);
    }
  }
  return verdict;
}
