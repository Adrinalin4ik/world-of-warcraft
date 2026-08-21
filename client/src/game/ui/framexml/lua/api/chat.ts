/**
 * THE CHAT ENGINE GLOBALS -- the ones `ChatFrame.lua` needs before it can define anything.
 *
 * ## Why this file is the difference between "chat is missing" and "chat exists"
 *
 * `ChatFrame.lua` has a loop AT FILE SCOPE, line 2273:
 *
 *     for index, value in pairs(ChatTypeInfo) do
 *         value.r = 1.0; value.g = 1.0; value.b = 1.0;
 *         value.id = GetChatTypeIndex(index);
 *     end
 *
 * `GetChatTypeIndex` was absent, so that loop raised -- and a raise at file scope stops the CHUNK. Every
 * function declared BELOW line 2273 therefore never existed: `ChatFrame_OnLoad`, `ChatFrame_OnEvent`,
 * `ChatFrame_MessageEventHandler`, the whole `ChatEdit_*` family, `ChatFrame_AddMessageEventFilter` --
 * the entire runtime half of chat, from one missing global. That is the second of the two root causes
 * behind "chat is dead at load"; the first was `ScrollingMessageFrame` not being a widget class, which
 * is fixed in `lua/methods/messageframe.ts` and `lua/object.ts`.
 *
 * Nothing here decodes a packet. `SMSG_MESSAGECHAT` and the channel machinery are a separate piece of
 * work; this file exists so the client's own chat code LOADS, which is what the frames, the docking,
 * the tabs, the edit box and four waiting producers all sit behind.
 */
import { LuaVM } from '../vm';
import { notImplemented } from '../methods/region';

/**
 * The chat type ids, and **these are OURS rather than the engine's, which is stated because it matters
 * for exactly one thing and not for anything else.**
 *
 * `value.id` has two consumers and both only require that the number be STABLE and DISTINCT per type:
 * it is passed as `AddMessage`'s fifth argument (`chatframe.lua:2568`) and to
 * `UpdateColorByID(id, r, g, b)` (`:2522,2530`), which recolours the lines already on screen that
 * carry that id. Nothing compares it to a constant, nothing sends it, and nothing persists it -- so a
 * dense sequence assigned in first-seen order is behaviourally identical to the engine's own table,
 * which no served file states.
 *
 * The order is therefore `ChatTypeInfo`'s own iteration order, which `pairs` does not define -- and that
 * is fine for the same reason. What would NOT be fine is returning a constant for every type, because
 * `UpdateColorByID` would then recolour every line in the buffer when one channel's colour changed.
 */
const chatTypeIds = new Map<string, number>();

/** Reset between sessions so a reconnect does not keep growing the table. */
export function resetChatTypeIds(): void {
  chatTypeIds.clear();
}

export function installChatApi(vm: LuaVM): void {
  /**
   * `GetChatTypeIndex(typeName)` -> a stable number for that chat type.
   *
   * A NUMBER ALWAYS, never nil: the caller assigns it straight into `value.id` and then hands it to
   * `AddMessage` and `UpdateColorByID`, so nil would propagate into both. Note this is the inverse of
   * the usual rule in this codebase -- `0` is truthy in Lua and a global meaning "nothing" must answer
   * nil -- but this global never means "nothing"; every key it is asked about is a real chat type.
   */
  vm.registerFunction('GetChatTypeIndex', (args) => {
    const name = typeof args[0] === 'string' ? args[0] : '';
    let id = chatTypeIds.get(name);
    if (id === undefined) {
      // 1-based: the ids end up in `AddMessage`'s fifth argument, and a 0 there is indistinguishable
      // from "no id" for any future reader that tests it for truth.
      id = chatTypeIds.size + 1;
      chatTypeIds.set(name, id);
    }
    return [id];
  });

  /**
   * `GetChatWindowInfo(index)` -> `name, fontSize, r, g, b, alpha, shown, locked, docked`.
   *
   * REAL rather than a fixed stub, and the reason is a defect the first probe found: a stub answering
   * the same tuple for every window returned `docked = true`, and `FCFDock_AddChatFrame` does
   * `if ( position and position <= #dock.DOCKED_CHAT_FRAMES + 1 )` (`floatingchatframe.lua:1987`) --
   * comparing a BOOLEAN with a number, which raised in the OnLoad of ChatFrame2 through ChatFrame7.
   * **`docked` is a dock POSITION (a number) or nil**, never a boolean.
   *
   * Nil for every window here, which is not a shrug: it is exactly what the client's own
   * `FCF_ResetChatWindows` produces, since that function calls `FCF_UnDockFrame(ChatFrame1)` and
   * `FCF_UnDockFrame(ChatFrame2)` and leaves the rest untouched (`floatingchatframe.lua:1729,1745`).
   * A fresh install has no docked windows, and this client is a fresh install on every load because
   * nothing is persisted.
   *
   * `shown` is true for window 1 only -- `ChatFrame1` is the one authored `hidden="false"`
   * (`floatingchatframe.xml:871`) and the one `FCF_ResetChatWindows` names as `DEFAULT_CHAT_FRAME`.
   * The font size is 14, which is the value that function passes to `FCF_SetChatWindowFontSize` for
   * both windows it configures.
   */
  vm.registerFunction('GetChatWindowInfo', (args) => {
    const index = typeof args[0] === 'number' ? args[0] : 0;
    // The name is left EMPTY rather than invented: `FCF_SetWindowName` derives "General" and
    // "Combat Log" from the localized globals itself, and a name here would fight it.
    return ['', 14, 0.24, 0.24, 0.24, 1, index === 1, false, null];
  });

  /**
   * The rest of what the chat chunk reaches, declared so the load report names each one.
   *
   * THE VALUES ARE NOT ARBITRARY -- each is what a client with no chat backend truthfully answers, and
   * three of them are fed into a `for` bound or a comparison rather than tested for truth:
   *
   *  - `GetNumDisplayChannels`/`GetChannelList` bound loops over the channel list; empty is correct on a
   *    client that has joined nothing.
   *  - `GetChatWindowInfo(i)` is destructured into nine values by `FCF_LoadChatWindow`
   *    (`floatingchatframe.lua:105`) -- the shape is what matters, and it was the OnLoad death for all
   *    nine `ChatFrame<N>TabDropDown` frames. `name, fontSize, r, g, b, alpha, shown, locked, docked`.
   *  - `GetChatWindowMessages`/`GetChatWindowChannels` return the saved per-window subscriptions; empty
   *    means a fresh install, which is what this client is on every load since nothing is persisted.
   */
  const gaps: [string, string, unknown[]][] = [
    // `FCF_RestorePositionAndDimensions` (`floatingchatframe.lua:1126-1136`) reads both, and it is
    // called from the OnLoad of ChatFrame2..7 -- so their absence was SIX load errors, measured. Both
    // guard their results (`if ( width and height )`, `if ( point )`), so returning NOTHING is the
    // correct "no saved layout" answer and leaves each frame at its authored size and anchor.
    ['GetChatWindowSavedDimensions', 'no chat window layout is persisted, so each frame keeps its '
      + 'authored size', []],
    ['GetChatWindowSavedPosition', 'no chat window layout is persisted, so each frame keeps its '
      + 'authored anchor', []],
    ['GetChatWindowMessages', 'no chat settings are persisted', []],
    ['GetChatWindowChannels', 'no chat settings are persisted', []],
    ['AddChatWindowMessages', 'no chat settings are persisted', []],
    ['RemoveChatWindowMessages', 'no chat settings are persisted', []],
    ['AddChatWindowChannel', 'no chat settings are persisted', []],
    ['RemoveChatWindowChannel', 'no chat settings are persisted', []],
    ['SetChatWindowName', 'no chat settings are persisted', []],
    ['SetChatWindowSize', 'no chat settings are persisted', []],
    ['SetChatWindowColor', 'no chat settings are persisted', []],
    ['SetChatWindowAlpha', 'no chat settings are persisted', []],
    ['SetChatWindowShown', 'no chat settings are persisted', []],
    ['SetChatWindowLocked', 'no chat settings are persisted', []],
    ['SetChatWindowDocked', 'no chat settings are persisted', []],
    ['SetChatWindowUninteractable', 'no chat settings are persisted', []],
    // The channel system: `CMSG_JOIN_CHANNEL` and its family are not sent, and no channel list is read.
    ['GetChannelList', 'no chat channel is joined: CMSG_JOIN_CHANNEL is not sent', []],
    ['GetNumDisplayChannels', 'no chat channel is joined', [0]],
    ['GetChannelDisplayInfo', 'no chat channel is joined', []],
    ['JoinPermanentChannel', 'no chat channel is joined', []],
    ['JoinTemporaryChannel', 'no chat channel is joined', []],
    ['LeaveChannelByName', 'no chat channel is joined', []],
    ['ListChannels', 'no chat channel is joined', []],
    ['ListChannelByName', 'no chat channel is joined', []],
    ['GetChannelName', 'no chat channel is joined', [0, '', 0]],
    // Colours. `ChangeChatColor` would persist a CVar this client does not keep, and the reader
    // (`GetChatTypeIndex`-tagged lines) is already satisfied by the defaults set at file scope.
    ['ChangeChatColor', 'no chat colour is persisted, so a change would not survive the frame', []],
    ['GetChatTypeColor', 'no chat colour is persisted', [1, 1, 1]],
    // Sending. This is the piece a later round replaces with `CMSG_MESSAGECHAT`; it is declared rather
    // than silently dropped so a Whisper that goes nowhere says so in the load report.
    ['SendChatMessage', 'CMSG_MESSAGECHAT is not built yet, so nothing this client types is sent', []],
    ['GetDefaultLanguage', 'no language state is read from the wire', ['Common', 7]],
    ['GetLanguageByIndex', 'no language state is read from the wire', ['Common', 7]],
    ['GetNumLanguages', 'no language state is read from the wire', [1]],
    // The logging commands two slash handlers reach.
    ['LoggingChat', 'this client writes no chat log file', [false]],
    ['LoggingCombat', 'this client writes no combat log file', [false]],
  ];
  for (const [name, reason, results] of gaps) {
    const stub = notImplemented(name, reason, results);
    // `notImplemented` builds a FRAME METHOD (ctx, self, args); a global takes only args. The same
    // adaptation `api/units.ts` and `ui/group-bridge.ts` make, and for the same reason: what is reused
    // is the NAME REGISTRATION, which is the part the load report reads.
    vm.registerFunction(name, () => stub(null as never, 0, []));
  }
}

export default installChatApi;
