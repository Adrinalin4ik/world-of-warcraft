/**
 * CHAT CHANNELS, the Lua half -- the globals the client's own `/join` path calls.
 *
 * `network/game/object/channel.ts` is the wire. This file holds no frames: it registers the engine
 * globals over that handler's membership list and fires the events the client listens for.
 *
 * ## Why `/join` and not an auto-join
 *
 * The real client joins the zone channels by itself, and the NAME it sends is the part this project
 * cannot source: General is not called "General" on the wire but `General - <ZoneName>`, built from
 * `ChatChannels.dbc`'s name, that row's flags and the current zone. The flag bit that marks a channel
 * zone-dependent is not stated by any file served here, so auto-joining would mean guessing a name and
 * then guessing why the server said nothing -- the exact shape that cost three rounds on the item link.
 *
 * `SlashCmdList["JOIN"]` is already in the client (`chatframe.lua:1526-1545`) and calls
 * `JoinPermanentChannel(name, password, frameId, 1)`. So making that global real hands the owner a
 * working `/join General`, and the server's `SMSG_CHANNEL_NOTIFY` then reports the channel's REAL name
 * back. That is the measurement auto-join needs, taken through the client's own door rather than a
 * probe -- and it is useful on its own, which is why it lands first.
 *
 * ## What the numbers are
 *
 * `GetChannelName` answers an INDEX, `/1` addresses a channel by it, and `SendChatMessage(text,
 * "CHANNEL", lang, n)` names one that way -- but no packet carries it. The server speaks names
 * throughout. `ChannelHandler` owns the numbering for that reason; see its `joined` field.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { fireEvent } from './framexml/lua/events';
import { setChannelSource } from './framexml/lua/api/chat';

export function attachChannelBridge(vm: LuaVM, world: World): () => void {
  const channels = world.game?.objectHandler?.channelHandler ?? null;
  if (channels === null) {
    return () => {};
  }

  /**
   * `JoinPermanentChannel(name, password, frameId, zoneUpdate)` -> `zoneChannelNumber, channelName`.
   *
   * BOTH RETURNS MATTER AND THE FIRST IS A GATE: `SlashCmdList["JOIN"]` prints
   * `CHAT_INVALID_NAME_NOTICE` and returns early when the first return is falsy
   * (`chatframe.lua:1538-1542`). So answering a number optimistically would tell the player they had
   * joined a channel the server may refuse.
   *
   * ANSWERS NOTHING, and that is honest rather than pessimistic: the join is a round trip, membership is
   * confirmed by `SMSG_CHANNEL_NOTIFY` (see `channel.ts`), and at the moment this returns the answer is
   * genuinely unknown. The client's early return then skips its own list-walk, and the CHANNEL list is
   * rebuilt from the notify a moment later by `onChannels` below -- which is the same edge the real
   * client's list is built on.
   */
  vm.registerFunction('JoinPermanentChannel', (args) => {
    const name = String(args[0] ?? '').trim();
    if (name === '') {
      return [];
    }
    // `0` for the DBC id: a name typed by a player is a custom channel as far as the wire is
    // concerned, and the server resolves a built-in name itself. See `channel.ts#join`.
    channels.join(0, name, String(args[1] ?? ''));
    return [];
  });

  vm.registerFunction('JoinTemporaryChannel', (args) => {
    const name = String(args[0] ?? '').trim();
    if (name !== '') {
      channels.join(0, name, String(args[1] ?? ''));
    }
    return [];
  });

  vm.registerFunction('LeaveChannelByName', (args) => {
    const name = String(args[0] ?? '').trim();
    if (name !== '') {
      channels.leave(0, name);
    }
    return [];
  });

  /**
   * `GetChannelName(nameOrIndex)` -> `number, name, instanceId`.
   *
   * BOTH ARGUMENT FORMS, because the client uses both: `ChatEdit_UpdateHeader` passes the edit box's
   * `channelTarget` (a number) and `ChatEdit_ExtractChannel` passes a typed word (a name), and
   * `SetItemRef`'s channel arm tests `GetChannelName(tonumber(chatTarget)) == 0` to decide whether the
   * player is still in a channel (`itemref.lua:164`).
   *
   * ZERO for a channel this character is not in, which is what that test reads -- and a NUMBER rather
   * than nil, deliberately: `== 0` on a nil raises, and the client compares rather than tests truth.
   * This is the one place in this file where 0 is the right answer instead of nothing.
   *
   * `instanceId` is 0: it distinguishes multiple instances of one zone channel and this client is never
   * in more than one.
   */
  vm.registerFunction('GetChannelName', (args) => {
    const raw = args[0];
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      const name = channels.nameOf(asNumber);
      return name === null ? [0, '', 0] : [asNumber, name, 0];
    }
    const number = channels.numberOf(String(raw ?? ''));
    return number === 0 ? [0, '', 0] : [number, channels.nameOf(number) ?? '', 0];
  });

  /**
   * `GetChannelList()` -> a FLAT list of `number, name, disabled` triples.
   *
   * Flat and not a table: the client consumes it with `select` over a vararg
   * (`ChatFrame_RegisterForChannels`' shape, and `ChatConfigFrame`'s channel list does the same), so a
   * table here would arrive as one value.
   *
   * `disabled` is false for every entry -- it marks a channel the player has muted, and nothing in this
   * client can mute one yet.
   */
  vm.registerFunction('GetChannelList', () => {
    const out: unknown[] = [];
    for (const entry of channels.channels) {
      out.push(entry.number, entry.name, false);
    }
    return out;
  });

  vm.registerFunction('GetNumDisplayChannels', () => [channels.channels.length]);

  /**
   * `GetChatWindowChannels(index)` -> `name, zoneChannelNumber` PAIRS.
   *
   * **THIS IS WHAT MAKES AN INCOMING CHANNEL MESSAGE VISIBLE**, and it was a declared gap. The chain is
   * `UPDATE_CHAT_WINDOWS` -> `ChatFrame_RegisterForChannels(self, GetChatWindowChannels(self:GetID()))`
   * (`chatframe.lua:2511`), which fills `frame.channelList`; `ChatFrame_MessageEventHandler` then shows
   * a `CHAT_MSG_CHANNEL` line only if the channel is in that list. So with this empty every channel
   * message the server sent was decoded, coloured and dropped.
   *
   * WINDOW 1 ONLY, and every channel this character is in. The real client keeps a per-window
   * subscription in its saved variables; this client persists nothing (`api/chat.ts` declares that), so
   * the honest reading of "no saved settings" is that the default window shows what the player joined.
   */
  vm.registerFunction('GetChatWindowChannels', (args) => {
    if (Number(args[0]) !== 1) {
      return [];
    }
    const out: unknown[] = [];
    for (const entry of channels.channels) {
      out.push(entry.name, entry.number);
    }
    return out;
  });

  /**
   * THE NUMBER -> NAME TRANSLATION FOR A SEND, and without it a channel message could not be addressed.
   *
   * `ChatEdit_SendText` passes `editBox:GetAttribute("channelTarget")` as `SendChatMessage`'s fourth
   * argument (`chatframe.lua:3683`), and that attribute is a NUMBER. The wire wants the channel's NAME.
   * Nothing between them knew the mapping, so a `/1 hello` would have put "1" on the wire as the channel
   * name and been discarded in silence.
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
    setChannelSource(vm, null);
  };
}
