/**
 * CHAT CHANNELS, the Lua half -- and it supplies DATA rather than registering globals.
 *
 * `network/game/object/channel.ts` is the wire. The globals themselves live in
 * `framexml/lua/api/chat.ts` and are registered at API install time; this file installs the sink they
 * read and fires the events the client redraws on.
 *
 * **THAT DIVISION IS NOT STYLE, IT IS A BUG I ALREADY SHIPPED.** The first version registered
 * `GetChatWindowChannels` and its neighbours here. This bridge attaches AFTER the manifest, and the chat
 * bridge fires `UPDATE_CHAT_WINDOWS` before it, whose arm calls
 * `ChatFrame_RegisterForChannels(self, GetChatWindowChannels(self:GetID()))` (`chatframe.lua:2511`) --
 * a nil global throws there, `ChatFrame_OnEvent` aborts, `FloatingChatFrame_OnEvent` never runs, and the
 * chat window never gets its colour or alpha. The owner saw a white box, the same symptom
 * `GetObjectType` and `SetHyperlinksEnabled` each produced before it. See `api/chat.ts#ChannelSink`.
 *
 * ## The auto-join, and why the paragraph that used to stand here was wrong
 *
 * It said auto-joining would mean guessing: that `General - <ZoneName>` is built from a flag no served
 * file states, so the name and the set were both unsourced. Then I dumped `ChatChannels.dbc` and both
 * were stated by the data -- zone-dependence by a `%s` IN THE NAME, and the auto-join set by flag bit
 * `0x1`, clear on exactly the two rows nobody is auto-joined to. See `dbc/chat-channel-data.ts` for
 * the six-row dump.
 *
 * So the guess was never necessary; I had declined to read the file. `/join` remains real and is what
 * a player uses for a custom channel, but the zone channels are joined the way the client joins them.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { fireEvent } from './framexml/lua/events';
import { setChannelSink, setChannelSource } from './framexml/lua/api/chat';
import { CHANNEL_NOTIFY } from '../../network/game/object/channel';
import { currentZone, onZoneChanged } from './zone-watch';
import chatChannelData, { nameFor } from '../pipeline/dbc/chat-channel-data';

/**
 * `SMSG_CHANNEL_NOTIFY`'s type -> the client's own notice NAME, which is `arg1`.
 *
 * Each has a `CHAT_<NAME>_NOTICE` string in `globalstrings.lua` -- checked, because a name without
 * one makes the client `format` a nil. A type not in this table is skipped rather than announced.
 */
const NOTICE_LABELS: Record<number, string> = {
  [CHANNEL_NOTIFY.YOU_JOINED]: 'YOU_JOINED',
  [CHANNEL_NOTIFY.YOU_LEFT]: 'YOU_LEFT',
  [CHANNEL_NOTIFY.WRONG_PASSWORD]: 'WRONG_PASSWORD',
  [CHANNEL_NOTIFY.NOT_MEMBER]: 'NOT_MEMBER',
  [CHANNEL_NOTIFY.BANNED]: 'BANNED',
  [CHANNEL_NOTIFY.INVALID_NAME]: 'INVALID_NAME',
  [CHANNEL_NOTIFY.NOT_MODERATED]: 'NOT_MODERATED',
};

export function attachChannelBridge(vm: LuaVM, world: World): () => void {
  const channels = world.game?.objectHandler?.channelHandler ?? null;
  if (channels === null) {
    return () => {};
  }

  setChannelSink(vm, {
    channels: () => channels.channels,
    // `0` for the DBC id: a name typed by a player is a custom channel as far as the wire is
    // concerned, and the server resolves a built-in name itself. See `channel.ts#join`.
    join: (name: string, password: string) => channels.join(0, name, password),
    leave: (name: string) => channels.leave(0, name),
  });

  /**
   * THE NUMBER -> NAME TRANSLATION FOR A SEND, without which a channel message is unaddressable.
   *
   * `ChatEdit_SendText` passes `editBox:GetAttribute("channelTarget")` as `SendChatMessage`'s fourth
   * argument (`chatframe.lua:3683`), and that attribute is a NUMBER. The wire wants the channel's NAME.
   * Nothing between them knew the mapping, so a `/1 hello` would have put "1" on the wire as the channel
   * name and been discarded in silence.
   *
   * A name passed straight through is accepted too: `ChatEdit_ExtractChannel` sets the attribute from a
   * typed word in one path, so the target is not always a number.
   */
  setChannelSource(vm, (target: string) => {
    const asNumber = Number(target);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return channels.nameOf(asNumber);
    }
    return target === '' ? null : target;
  });

  /**
   * A NOTIFY BECOMES THE CLIENT'S OWN `CHAT_MSG_CHANNEL_NOTICE`, which is what prints "Joined
   * Channel: [1. world]".
 *
   * The owner joined a channel and saw no confirmation. Correct: that line is not sent by the server,
   * it is composed by the CLIENT from an event the ENGINE fires. `ChatFrame_MessageEventHandler`'s
   * `CHANNEL_NOTICE` arm builds it as `format(_G["CHAT_"..arg1.."_NOTICE"], arg8, arg4)`
   * (`chatframe.lua:2791-2801`), and `CHAT_YOU_JOINED_NOTICE` is `"Joined Channel:
   * |Hchannel:%d|h[%s]|h"` (`globalstrings.lua:1613`). Nothing fired it, so nothing printed.
   *
   * THE ARGUMENT POSITIONS ARE READ OFF THE HANDLER, not guessed, and three of them are traps:
   *
   *  - `arg4` is the name WITH the number in front (`1. world`). The matching loop requires
   *    `strlen(arg4) > strlen(value)` where `value` is the bare name from `channelList`
   *    (`:2694,2707`), so a bare `arg4` would never match and the notice would be dropped;
   *  - `arg9` is the name WITHOUT it -- the file says so in a comment on that very line;
   *  - `arg7` and `arg10` are COMPARED (`arg7 > 0`, `arg10 > 0`), so they must be NUMBERS. A nil
   *    there raises inside the handler and takes the whole line with it, which is this project's
   *    most repeated failure and would have looked like "the notice still does not print".
   *
   * `arg7` is the zone-channel id and 0 is right for a custom channel: it makes the loop fall through
   * to the name comparison, which is the branch that matches here. The id is in the notify's
   * type-dependent tail, which `channel.ts` deliberately does not read.
   */
  const onNotice = (notice: { type: number; name: string; number: number }): void => {
    const label = NOTICE_LABELS[notice.type] ?? null;
    if (label === null) {
      // A notify with no `CHAT_<NAME>_NOTICE` string would make the client format a nil. Recorded by
      // `window.channelWire` either way, so nothing is lost silently.
      return;
    }
    const numbered = notice.number > 0 ? `${notice.number}. ${notice.name}` : notice.name;
    fireEvent(vm, 'CHAT_MSG_CHANNEL_NOTICE', [
      label, '', '', numbered, '', '', 0, notice.number, notice.name, 0,
    ]);
  };
  channels.on('notice', onNotice);

  /**
   * Membership changed -> tell the client, through the two events it already listens to.
   *
   * `CHANNEL_UI_UPDATE` is what the channel list frames redraw on, and `UPDATE_CHAT_WINDOWS` is what
   * re-runs `ChatFrame_RegisterForChannels` -- so a channel joined after login starts displaying without
   * a reload. Firing both is what the real client does on the same edge.
   */
  const onChannels = (): void => {
    fireEvent(vm, 'CHANNEL_UI_UPDATE');
    fireEvent(vm, 'UPDATE_CHAT_WINDOWS');
  };
  channels.on('channelsChanged', onChannels);

  /**
   * THE ZONE CHANNELS, joined when the zone is known and re-joined when it changes.
   *
   * `General - %s` takes the zone name (`dbc/chat-channel-data.ts`), so the join cannot be sent until
   * the terrain under the player has resolved -- which is after this bridge attaches. Hence a poll on
   * the zone sink rather than a one-shot: `ui/zone-watch.ts` carries what the map bridge already
   * computes every tick, and this reads it on the UI tick it is called from.
   *
   * IDEMPOTENT AT EVERY LEVEL, which is what makes calling it repeatedly free: `nameFor` answers null
   * while the zone is unknown, `ChannelHandler#join` drops a name already joined or already in flight,
   * and the DBC load dedupes internally. So the steady state is a string compare per channel per call.
   *
   * **LEAVING THE OLD ZONE CHANNEL IS NOT DONE HERE, and that is a stated gap rather than an
   * oversight.** The real client leaves `General - Elwynn Forest` on entering Westfall. Doing that
   * needs the previous zone's name and a `CMSG_LEAVE_CHANNEL` per row, and it interacts with the
   * POSITIONAL numbering (`channel.ts#joined`): a leave renumbers, so `/1` would silently address a
   * different channel mid-session. Worth doing, worth doing deliberately, and the server keeping us in
   * a channel we have walked out of is visible rather than silent -- it shows up as an extra row in
   * `GetChannelList`.
   */
  let joinedForZone = '';
  const joinZoneChannels = (): void => {
    const zone = currentZone();
    if (zone === '' || zone === joinedForZone) {
      return;
    }
    const rows = chatChannelData.autoJoin;
    if (rows.length === 0) {
      // The DBC has not landed. `ensureLoaded` below re-enters this once it has.
      return;
    }
    joinedForZone = zone;
    for (const row of rows) {
      const name = nameFor(row, zone);
      if (name !== null) {
        // THE DBC ID, not 0: a built-in channel is identified by it, and the server resolves the row
        // itself rather than treating the name as a custom channel. See `channel.ts#join`.
        channels.join(row.id, name);
      }
    }
  };
  void chatChannelData.ensureLoaded().then(joinZoneChannels);

  /**
   * **AND FIRE IT ONCE NOW, BECAUSE THE EDGE THIS BRIDGE WAITS FOR HAS ALREADY PASSED.**
   *
   * MEASURED: with a channel joined and `GetChannelList()` answering it, `ChatFrame1.channelList[1]`
   * was still nil -- so `ChatFrame_MessageEventHandler` matched no channel for an incoming line and
   * dropped every one of them (`chatframe.lua:2705-2723`). The list is filled only by
   * `ChatFrame_RegisterForChannels(self, GetChatWindowChannels(self:GetID()))`, in the
   * `UPDATE_CHAT_WINDOWS` arm (`:2511`).
   *
   * Two ways that edge is missed, and both are ordering:
   *
   *  - `attachChatBridge` fires `UPDATE_CHAT_WINDOWS` when IT attaches, and this bridge installs the
   *    channel sink AFTER it. So at the moment of that one dispatch `GetChatWindowChannels` truthfully
   *    answered "no channels", and nothing fired it again;
   *  - a server that remembers channel membership sends `YOU_JOINED` during LOGIN, before this bridge
   *    has subscribed to `channelsChanged` -- so the handler adds the channel and emits to nobody.
   *
   * This is the lesson `unit-bridge.ts#seedUnitSnapshots` already records: the real client has this
   * state before the UI asks, and a bridge that attaches later has to SAY so rather than wait for an
   * edge that will never come. One dispatch at attach, which is also what re-runs
   * `ChatFrame_RegisterForMessages` -- idempotent, and the same call the arm makes on every real
   * update.
   */
  onChannels();

  /**
   * THE ZONE EDGE, which the map bridge announces from the poll it already runs.
   *
   * My first version retried on `notice` and `channelsChanged` instead, and it DEADLOCKED: there are
   * no channel events until something is joined, and nothing can be joined until the zone is known.
   * `ui/zone-watch.ts` carries the edge for exactly that reason.
   */
  const offZone = onZoneChanged(joinZoneChannels);

  return () => {
    channels.removeListener('channelsChanged', onChannels);
    offZone();
    channels.removeListener('notice', onNotice);
    // Both close over this session; a stale one outliving it is the double-mount hazard.
    setChannelSink(vm, null);
    setChannelSource(vm, null);
  };
}
