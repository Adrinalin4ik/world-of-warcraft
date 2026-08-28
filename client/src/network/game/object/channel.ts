/**
 * CHAT CHANNELS -- `CMSG_JOIN_CHANNEL` (0x097), `CMSG_LEAVE_CHANNEL` (0x098) and
 * `SMSG_CHANNEL_NOTIFY` (0x099).
 *
 * `game/ui/channel-bridge.ts` is the Lua half; this file is the wire and holds no frames.
 *
 * ## Membership is CONFIRMED, never assumed, and that is the whole design
 *
 * The join body's 3.3.5a layout is the risky part of this file: 1.12 sent a name and a password and
 * nothing else, and 3.3.5a prefixes two more fields. The reference is 1.12, so per the project rule it
 * is authoritative on MECHANISM and not on this. A wrong body here fails the way every wrong width in
 * this project has -- the server's `ByteBuffer` reads past the end, discards the packet and answers
 * NOTHING.
 *
 * So nothing is added to the list on the strength of the send. A channel appears only when
 * `SMSG_CHANNEL_NOTIFY` says `YOU_JOINED`, which means:
 *
 *  - if the layout is right, the client learns its channels from the server, which is also how the real
 *    client learns them;
 *  - if the layout is wrong, `GetChannelList` stays empty and the UI honestly shows no channels --
 *    rather than listing channels the player is not in and dropping every message sent to them.
 *
 * The confirmation is therefore the instrument as well as the mechanism, and `window.channelWire`
 * records every notify with its residual so a wrong arm is visible rather than inferred.
 *
 * ## The join body
 *
 *     u32     channelId     -- the `ChatChannels.dbc` id, or 0 for a custom channel
 *     u8      hasVoice
 *     u8      joinedByZoneUpdate
 *     cstring channelName
 *     cstring password
 *
 * The two `u8` flags are what 3.3.5a added; both are 0 for a plain join. THE LONGER BODY IS THE SAFE
 * DIRECTION here, which this project has already paid to learn: a server that does not read the two
 * bytes ignores them, while one that does read them and does not get them reads into the name.
 *
 * ## The notify body
 *
 *     u8      notifyType
 *     cstring channelName
 *     ...     type-dependent extras
 *
 * Only the types this client acts on are decoded; the rest are recorded and skipped rather than
 * mis-read, and the residual instrument shows which arrived.
 */
import { EventEmitter } from 'events';

import { GameHandler } from '../handler';
import GameOpcode from '../opcode';
import GamePacket from '../packet';

/**
 * `SMSG_CHANNEL_NOTIFY`'s first byte.
 *
 * The values this client acts on, from the server's own enum order. The two that matter are the pair
 * that opens and closes membership; everything else is a notice the client's own Lua renders from
 * `CHAT_MSG_CHANNEL_NOTICE`, which needs no engine state.
 */
export const CHANNEL_NOTIFY = {
  YOU_JOINED: 0x02,
  YOU_LEFT: 0x03,
  WRONG_PASSWORD: 0x04,
  NOT_MEMBER: 0x05,
  BANNED: 0x08,
  INVALID_NAME: 0x0d,
  NOT_MODERATED: 0x0e,
} as const;

/** One channel this character is in. `number` is the client-side index the UI addresses it by. */
export interface JoinedChannel {
  /** 1-based, in JOIN ORDER -- see `ChannelHandler#channels` for why the engine owns it. */
  number: number;
  name: string;
}

export class ChannelHandler extends EventEmitter {
  private game: GameHandler;

  /**
   * The channels this character is in, in join order.
   *
   * **THE NUMBER IS THE ENGINE'S AND IS POSITIONAL.** `GetChannelName` answers an index, `/1` and `/2`
   * address channels by it, and `SendChatMessage(text, "CHANNEL", lang, n)` names one that way -- but no
   * packet carries it. The server speaks channel NAMES throughout; the numbering is entirely a client
   * convention, which is why it lives here and not on the wire, and why a leave RENUMBERS the rest
   * exactly as leaving a channel in the real client does.
   */
  private joined: JoinedChannel[] = [];

  /** Names a join has been sent for and not yet answered. Kept so a retry does not double-send. */
  private inFlight = new Set<string>();

  constructor(gameHandler: GameHandler) {
    super();
    this.game = gameHandler;
    this.game.on('packet:receive:SMSG_CHANNEL_NOTIFY', (gp: GamePacket) => {
      const bodySize = gp.bodySize;
      try {
        this.notify(gp);
        channelWire.record({
          opcode: 'SMSG_CHANNEL_NOTIFY', bodySize, consumed: gp.index - gp.headerSize, threw: false,
        });
      } catch (e) {
        channelWire.record({
          opcode: 'SMSG_CHANNEL_NOTIFY', bodySize, consumed: gp.index - gp.headerSize, threw: true,
        });
        // `object/loot.ts#subscribe`'s contract: `byte-buffer` throws past the frame and an uncaught
        // throw escapes the receive loop, taking every packet still buffered with it.
        console.warn('ChannelHandler: SMSG_CHANNEL_NOTIFY decode threw', e);
      }
    });
  }

  /** The channels this character is in. A copy, so a caller cannot renumber the engine's list. */
  get channels(): JoinedChannel[] {
    return this.joined.map((entry) => ({ ...entry }));
  }

  /** The 1-based index of a channel by name, or 0 for one this character is not in. */
  numberOf(name: string): number {
    const lower = name.toLowerCase();
    return this.joined.find((entry) => entry.name.toLowerCase() === lower)?.number ?? 0;
  }

  /** The name of a channel by its 1-based index, or null. */
  nameOf(number: number): string | null {
    return this.joined.find((entry) => entry.number === number)?.name ?? null;
  }

  /**
   * `CMSG_JOIN_CHANNEL` -- ask to join, and add nothing until the server agrees.
   *
   * Deduplicated on both the joined list and the in-flight set, so a caller that fires on every zone
   * change (which is what the real client does) sends one packet per channel per session.
   */
  join(channelId: number, name: string, password = ''): void {
    if (name === '' || this.numberOf(name) > 0 || this.inFlight.has(name.toLowerCase())) {
      return;
    }
    this.inFlight.add(name.toLowerCase());
    const body = 4 + 1 + 1 + cstrBytes(name) + cstrBytes(password);
    const gp = new GamePacket(
      GameOpcode.CMSG_JOIN_CHANNEL,
      GamePacket.HEADER_SIZE_OUTGOING + body,
    );
    gp.writeUnsignedInt(channelId);
    // Both flags 0: no voice session, and not a zone-update join. See the header on the body.
    gp.writeUnsignedByte(0);
    gp.writeUnsignedByte(0);
    gp.writeCString(name);
    gp.writeCString(password);
    this.game.send(gp);
  }

  /** `CMSG_LEAVE_CHANNEL` -- `u32 channelId` then the name, the mirror of the join. */
  leave(channelId: number, name: string): void {
    if (name === '') {
      return;
    }
    const body = 4 + cstrBytes(name);
    const gp = new GamePacket(
      GameOpcode.CMSG_LEAVE_CHANNEL,
      GamePacket.HEADER_SIZE_OUTGOING + body,
    );
    gp.writeUnsignedInt(channelId);
    gp.writeCString(name);
    this.game.send(gp);
  }

  private notify(gp: GamePacket): void {
    const type = gp.readUnsignedByte();
    const name = gp.readCStr();
    if (name === '') {
      return;
    }
    this.inFlight.delete(name.toLowerCase());
    if (type === CHANNEL_NOTIFY.YOU_JOINED) {
      if (this.numberOf(name) === 0) {
        this.joined.push({ number: this.joined.length + 1, name });
        this.emit('channelsChanged', this.channels);
      }
      return;
    }
    if (type === CHANNEL_NOTIFY.YOU_LEFT) {
      const lower = name.toLowerCase();
      const kept = this.joined.filter((entry) => entry.name.toLowerCase() !== lower);
      if (kept.length !== this.joined.length) {
        // RENUMBERED, because the index is positional -- see `joined`.
        this.joined = kept.map((entry, index) => ({ ...entry, number: index + 1 }));
        this.emit('channelsChanged', this.channels);
      }
    }
    // Every other notify is a NOTICE the client renders from its own `CHAT_MSG_CHANNEL_NOTICE` feed and
    // needs no engine state, so it is recorded by the wire instrument and otherwise left alone. The
    // type-dependent tail is deliberately not read: a wrong arm would read past the frame, and the
    // residual makes an unconsumed tail visible instead of guessed at.
  }
}

/** The byte cost of `writeCString`. Same arithmetic as `object/chat.ts#cstrBytes`. */
function cstrBytes(value: string): number {
  let bytes = 1;
  for (let i = 0; i < value.length; ++i) {
    const c = value.charCodeAt(i);
    if (c <= 0x7f) {
      bytes += 1;
    } else if (c <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

interface ChannelWireRow {
  at: number;
  opcode: string;
  bodySize: number;
  consumed: number;
  threw: boolean;
}

/**
 * The residual instrument, on `window.channelWire`.
 *
 * `bad` is not "every unconsumed body" here, unlike `chatWire`: most notify types carry a tail this
 * file deliberately does not read, so an unconsumed remainder is expected for them. What `bad` reports
 * is a THROW -- the only outcome that proves an arm read past the frame.
 */
class ChannelWire {
  public rows: ChannelWireRow[] = [];

  record(row: Omit<ChannelWireRow, 'at'>): void {
    this.rows.push({ at: performance.now(), ...row });
    if (this.rows.length > 200) {
      this.rows.splice(0, this.rows.length - 200);
    }
  }

  get bad(): ChannelWireRow[] {
    return this.rows.filter((r) => r.threw);
  }
}

export const channelWire = new ChannelWire();
if (typeof window !== 'undefined') {
  (window as never as Record<string, unknown>).channelWire = channelWire;
}
