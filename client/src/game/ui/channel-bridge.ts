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
 * ## Why `/join` and not an auto-join
 *
 * General is not called "General" on the wire -- it is `General - <ZoneName>`, built from
 * `ChatChannels.dbc`'s name, that row's flags and the current zone. The flag bit marking a channel
 * zone-dependent is stated by no file served here, so auto-joining would mean guessing a name and then
 * guessing why the server said nothing.
 *
 * `SlashCmdList["JOIN"]` is already in the client (`chatframe.lua:1526-1545`), so a real
 * `JoinPermanentChannel` gives a working `/join General` AND makes the server report the channel's real
 * name back through `SMSG_CHANNEL_NOTIFY`. That is the measurement auto-join needs, taken through the
 * client's own door rather than a probe.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { fireEvent } from './framexml/lua/events';
import { setChannelSink, setChannelSource } from './framexml/lua/api/chat';

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

  return () => {
    channels.removeListener('channelsChanged', onChannels);
    // Both close over this session; a stale one outliving it is the double-mount hazard.
    setChannelSink(vm, null);
    setChannelSource(vm, null);
  };
}
