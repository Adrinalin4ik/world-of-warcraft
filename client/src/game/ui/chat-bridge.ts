/**
 * CHAT'S LUA HALF -- turning a decoded line into the client's own `CHAT_MSG_*` event.
 *
 * NOTHING HERE DRAWS AND NOTHING HERE FORMATS. `ChatFrame_MessageEventHandler`
 * (`chatframe.lua:2570` and on) is ~400 lines of the client's own composition: it picks the
 * `CHAT_MSG_*` format string out of `GlobalStrings`, wraps the sender in a `|Hplayer:...|h` hyperlink,
 * applies `ChatTypeInfo`'s colour, honours the AFK/DND tag, and calls `AddMessage` on whichever frames
 * subscribe to that message group. All of that already loads (see `api/chat.ts` for what was stopping
 * it), so the whole job here is to raise the right event with the right arguments.
 *
 * ## THE ARGUMENT SHAPE, AND WHY IT IS TWELVE WIDE
 *
 * `ChatFrame_MessageEventHandler` reads `arg1..arg12` (via `...`), and the two that decide whether a
 * line renders at all are `arg1` (the text) and `arg2` (the sender's name) -- everything else refines
 * it. The order is the client's own, taken from how that function destructures:
 *
 *   1 text  2 senderName  3 languageName  4 channelName  5 targetName  6 senderTag
 *   7 zoneChannelId  8 channelIndex  9 channelBaseName  10 (unused)  11 lineId  12 senderGuid
 *
 * `arg6` is the AFK/DND/GM string the tag maps to -- NOT the numeric tag -- because
 * `ChatFrame_MessageEventHandler` concatenates it into the sender's name directly.
 *
 * ## THE SENDER'S NAME IS THE ONE HARD PART
 *
 * Only the monster and `WHISPER_FOREIGN` types carry a name on the wire; for a player line the packet
 * carries a GUID and the client is expected to know the name already. This client resolves it the way
 * the target frame does -- `GameHandler#playerNames`, filled by `SMSG_NAME_QUERY_RESPONSE` -- and asks
 * for it when it is missing. **A line whose name has not arrived is HELD, not rendered with a blank
 * sender**, because `chatframe.lua` splices `arg2` into a hyperlink and an empty name produces a
 * clickable link to nobody. The held line is flushed when the name lands.
 */
import type World from '../world';
import type { ChatLine, ChatMessageHandler } from '../../network/game/object/chat';
import { LuaVM } from './framexml/lua/vm';
import { fireEvent } from './framexml/lua/events';
import { chatColourEvents } from './chat-colours';
import { setChatSender } from './framexml/lua/api/chat';

/** `chatTag` -> the string `arg6` carries. 0 is none; the rest are the client's own globals. */
const TAG_TEXT: Record<number, string> = {
  1: 'CHAT_FLAG_AFK',
  2: 'CHAT_FLAG_DND',
  3: 'CHAT_FLAG_GM',
};

/**
 * The types whose sender is a CREATURE or the server itself, so no name query is possible or wanted.
 *
 * A monster line already carries its name; a system line has no sender at all (guid 0) and
 * `chatframe.lua` renders it with no name prefix. Holding either for a name query would hold it
 * forever.
 */
function needsPlayerName(line: ChatLine): boolean {
  return line.senderName === null && line.senderGuid !== '0x0';
}

export function attachChatBridge(vm: LuaVM, world: World): () => void {
  const chat: ChatMessageHandler = world.game.objectHandler.chatHandler;

  /**
   * OUTBOUND: give `SendChatMessage` somewhere to go.
   *
   * The global itself is registered in `api/chat.ts` before the manifest, because `ChatFrame.lua`
   * references it while loading; what it lacked was a handler. `object/chat.ts#send` has built
   * `CMSG_MESSAGECHAT` for some time and nothing called it -- the gap note there still said the
   * packet did not exist.
   *
   * The fourth argument is a player name for a whisper and a channel name for a channel, and `send`
   * picks by type, so both are handed the same string rather than this bridge deciding which is
   * which -- the client already made that call by the type it passed.
   */
  setChatSender((type, text, target, language) => {
    chat.send(type, text, target, target, language);
  });

  /** Lines waiting on a name query, oldest first. Bounded: a name that never arrives must not leak. */
  const pending: { line: ChatLine; at: number }[] = [];

  /** A monotonic line id -- `arg11`. The client uses it only as an identity for edit/removal. */
  let lineId = 0;

  const nameFor = (guid: string): string | null => {
    const names = (world.game as unknown as { playerNames?: Record<string, { name?: string }> })
      .playerNames;
    const entry = names?.[guid];
    const name = entry?.name;
    // A `playerNames` entry can hold the guid itself as a placeholder (`handler.js` seeds it that way),
    // so a "name" equal to the key is not a name.
    if (typeof name !== 'string' || name === '' || name === guid) {
      return null;
    }
    return name;
  };

  const raise = (line: ChatLine, senderName: string): void => {
    if (line.eventSuffix === null) {
      // An unknown type byte. Named on the console rather than dropped silently: it means the enum
      // above is missing a value this server sends, which is exactly the thing worth learning.
      console.warn(`chat: no CHAT_MSG_* name for type 0x${line.type.toString(16)}`);
      return;
    }
    lineId += 1;
    fireEvent(vm, `CHAT_MSG_${line.eventSuffix}`, [
      line.text,
      senderName,
      // The language NAME, not the id: `chatframe.lua` compares it against `GetDefaultLanguage()` to
      // decide whether to show the "[Language]" prefix. Empty means universal, which suppresses it.
      '',
      line.channel ?? '',
      line.targetName ?? '',
      TAG_TEXT[line.chatTag] ?? '',
      0,
      0,
      line.channel ?? '',
      0,
      lineId,
      line.senderGuid,
    ]);
  };

  const onLine = (line: ChatLine): void => {
    if (!needsPlayerName(line)) {
      raise(line, line.senderName ?? '');
      return;
    }
    const known = nameFor(line.senderGuid);
    if (known !== null) {
      raise(line, known);
      return;
    }
    // HELD, not rendered blank -- see the header. `askNameOnce` dedupes on both the cache and the
    // in-flight set, so a burst of lines from one stranger costs one query.
    if (typeof world.game?.askNameOnce === 'function') {
      world.game.askNameOnce(line.senderGuid);
    }
    pending.push({ line, at: performance.now() });
    // A name that never arrives must not hold a line forever. 64 is generous for the burst a busy
    // channel produces and small enough that a leak is impossible.
    while (pending.length > 64) {
      const dropped = pending.shift();
      if (dropped !== undefined) {
        // Rendered with the guid rather than discarded: a line the player cannot attribute is still a
        // line he should see, and this is visible enough to diagnose.
        raise(dropped.line, dropped.line.senderGuid);
      }
    }
  };

  /**
   * A name landed -- flush whatever was waiting on it, IN ARRIVAL ORDER.
   *
   * Order matters and a filter-then-render would lose it: two strangers speaking interleaved must not
   * be reordered by whose name query answered first. So the queue is walked once and only the entries
   * whose name is now known are taken, leaving the rest in place.
   */
  const onFields = (): void => {
    if (pending.length === 0) {
      return;
    }
    const still: typeof pending = [];
    for (const entry of pending) {
      const name = nameFor(entry.line.senderGuid);
      if (name === null) {
        still.push(entry);
      } else {
        raise(entry.line, name);
      }
    }
    pending.length = 0;
    pending.push(...still);
  };

  /**
   * **FIRE `UPDATE_CHAT_WINDOWS` ONCE, BECAUSE THE ENGINE DOES AND NOTHING HERE DID.**
   *
   * MEASURED: with `GetChatWindowMessages` returning a real group list, `ChatFrame1.messageTypeList`
   * was still empty and `ChatFrame1:IsEventRegistered("CHAT_MSG_SAY")` was FALSE -- so two real
   * `SMSG_MESSAGECHAT` bodies decoded with zero residual and reached nothing. The return value was
   * never the blocker; the TRIGGER was.
   *
   * `ChatFrame_RegisterForMessages` is the only thing that registers a frame for a `CHAT_MSG_*` event
   * (`chatframe.lua:2297-2310`), and its only caller is `ChatFrame_OnEvent`'s `UPDATE_CHAT_WINDOWS`
   * arm (`:2510`). That event is engine-fired at login, alongside `UPDATE_CHAT_COLOR`. Both are fired
   * here, once, when the bridge attaches -- which is after the manifest has built the frames, so every
   * `ChatFrame<N>` is present to receive it.
   *
   * The same ordering lesson as `unit-bridge.ts#seedUnitSnapshots`: the real client has this state
   * before the UI asks, and a bridge that attaches later has to say so explicitly rather than wait for
   * an edge that will never come.
   */
  /**
   * ONE `UPDATE_CHAT_COLOR` PER TYPE, because the arm reads `arg1` and this fired with none.
   *
   * `ChatTypeInfo` carries no colours in FrameXML at all -- see `chat-colours.ts`, which holds the
   * table and the citation. The argument-less fire below used to reach
   * `ChatTypeInfo[strupper(nil)]` and do nothing, so every line rendered with `info.r` nil and came
   * out white.
   */
  for (const [type, r, g, b] of chatColourEvents()) {
    fireEvent(vm, 'UPDATE_CHAT_COLOR', [type, r / 255, g / 255, b / 255]);
  }
  fireEvent(vm, 'UPDATE_CHAT_WINDOWS');

  chat.on('line', onLine);
  // `unit:fields` is what `applyPlayerName` ends with, so it is the edge a resolved name arrives on --
  // the same door `unit-bridge.ts` and the nameplate walker already listen at, rather than a new one.
  world.on('unit:fields', onFields);

  return () => {
    // The sender closes over this session; a stale one outliving it is the double-mount hazard.
    setChatSender(null);
    chat.removeListener('line', onLine);
    world.removeListener('unit:fields', onFields);
    pending.length = 0;
  };
}

export default attachChatBridge;
