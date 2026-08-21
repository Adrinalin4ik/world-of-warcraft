/**
 * INBOUND AND OUTBOUND CHAT -- `SMSG_MESSAGECHAT` (0x096) and `CMSG_MESSAGECHAT` (0x095).
 *
 * `game/ui/chat-bridge.ts` is the Lua half; this file is the wire and holds no frames.
 *
 * ## WHY THIS IS A NEW FILE RATHER THAN A FIX TO `network/game/chat/handler.js`
 *
 * That handler exists, decodes something close to the right shape, and **has never run once**. Four
 * independent reasons, all found by reading it:
 *
 *  1. it subscribes to `packet:receive:SMSG_MESSAGE_CHAT` -- with an underscore between MESSAGE and
 *     CHAT. The opcode is `SMSG_MESSAGECHAT`, so the event name never matches and it is never called;
 *  2. `send()` builds `GameOpcode.CMSG_MESSAGE_CHAT`, which **does not exist** in `opcode.js` (the name
 *     is `CMSG_MESSAGECHAT`), so the opcode was `undefined`;
 *  3. its body does `const message = null;` and then `message = new Message(...)` in every arm -- a
 *     `const` reassignment, which throws on the first message of any type;
 *  4. `Message` is not imported at all; that module's default export is named `ChatMessage`.
 *
 * And `ChatHandler` is **never constructed**: the only references to `chat/handler.js` anywhere in the
 * tree are three comments in `network/game/handler.js`. So the "three chat callers of `askName`" those
 * comments describe have never called anything -- worth knowing, because the name-query work reasoned
 * about them as live callers.
 *
 * Patching four faults in code nothing instantiates would leave the same untested surface, so this is
 * the same decode written where the other packet handlers live, with a residual instrument.
 *
 * ## THE LAYOUT, AND THE VERSION TRAP IN IT
 *
 * STRUCTURE from the reference, which byte-verified it against vmangos
 * (`samples/benilla/crates/benilla-protocol/src/messages/chat.rs`): `u8 type`, `u32 language`, a
 * per-type sender prefix, then `u32 len` -- **which includes the NUL** -- the text, and `u8 chatTag`.
 *
 * NUMBERS from 3.3.5a, and **the enum is shifted by one between the two versions**, which is exactly
 * the class of value `CLAUDE.md` says never to take from the reference. 1.12 has `SAY = 0x00`,
 * `PARTY = 0x01`, `YELL = 0x05`, `WHISPER = 0x06`; 3.3.5a inserts `SYSTEM` at `0x00` and shifts the rest
 * up, giving `SAY = 0x01`, `PARTY = 0x02`, `YELL = 0x06`, `WHISPER = 0x07`. Taking the reference's
 * values would have rendered every player line as the wrong type -- a say as a party message -- with no
 * error anywhere. The values below are corroborated IN THIS REPO by `network/game/chat/chatEnum.js`,
 * which carries the 3.3.5a set.
 *
 * 3.3.5a also adds two fields 1.12 does not have, both before the per-type block: a **full `u64` sender
 * guid** and a `u32` of flags. The reference carries its guid inside the per-type prefix instead.
 *
 * The per-type block is from **TrinityCore 3.3.5**'s `ChatHandler::BuildChatPacket`, labelled as a
 * server implementation exactly as the loot and group layouts are. `window.chatWire.bad` lists any
 * arrival whose `consumed` did not equal its `bodySize`; with a type-dependent body that residual is the
 * only thing that separates a wrong arm from a quiet one, which is how the trainer round used it.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GameOpcode from '../opcode';
import GamePacket from '../packet';
import { GUID_BYTES, guidHex } from '../../guid-hex';

/**
 * `ChatMsg`, 3.3.5a. See the header for why these are NOT the reference's values.
 *
 * Only the types this client can receive are named. The combat/skill/loot/money block (`0x1a`-`0x23`)
 * is composed client-side from its own opcodes rather than arriving here, exactly as the reference
 * records for 1.12, so those values are deliberately absent rather than guessed.
 */
export const ChatMsg = {
  SYSTEM: 0x00,
  SAY: 0x01,
  PARTY: 0x02,
  RAID: 0x03,
  GUILD: 0x04,
  OFFICER: 0x05,
  YELL: 0x06,
  WHISPER: 0x07,
  WHISPER_FOREIGN: 0x08,
  WHISPER_INFORM: 0x09,
  EMOTE: 0x0a,
  TEXT_EMOTE: 0x0b,
  MONSTER_SAY: 0x0c,
  MONSTER_PARTY: 0x0d,
  MONSTER_YELL: 0x0e,
  MONSTER_WHISPER: 0x0f,
  MONSTER_EMOTE: 0x10,
  CHANNEL: 0x11,
  CHANNEL_JOIN: 0x12,
  CHANNEL_LEAVE: 0x13,
  CHANNEL_LIST: 0x14,
  CHANNEL_NOTICE: 0x15,
  CHANNEL_NOTICE_USER: 0x16,
  AFK: 0x17,
  DND: 0x18,
  IGNORED: 0x19,
  BG_SYSTEM_NEUTRAL: 0x24,
  BG_SYSTEM_ALLIANCE: 0x25,
  BG_SYSTEM_HORDE: 0x26,
  RAID_LEADER: 0x27,
  RAID_WARNING: 0x28,
  RAID_BOSS_EMOTE: 0x29,
  RAID_BOSS_WHISPER: 0x2a,
  FILTERED: 0x2b,
  BATTLEGROUND: 0x2c,
  BATTLEGROUND_LEADER: 0x2d,
  RESTRICTED: 0x2e,
  BATTLENET: 0x2f,
  ACHIEVEMENT: 0x30,
  GUILD_ACHIEVEMENT: 0x31,
  PARTY_LEADER: 0x33,
} as const;

/**
 * Type byte -> the client's own event suffix, so the bridge fires `CHAT_MSG_<suffix>`.
 *
 * The NAMES are the client's, read out of `ChatFrame.lua`'s `ChatTypeGroup` (59 distinct `CHAT_MSG_*`
 * strings, and every suffix below appears among them). The MAPPING from byte to name has no
 * client-side source -- the engine owns it -- so it is derived from the enum above and shares its
 * labelling.
 */
const EVENT_SUFFIX = new Map<number, string>(
  Object.entries(ChatMsg).map(([name, value]) => [value as number, name]),
);

/** The types whose sender prefix is `u32 len` + name, then the receiver guid. */
const NAMED_SENDER = new Set<number>([
  ChatMsg.MONSTER_SAY, ChatMsg.MONSTER_PARTY, ChatMsg.MONSTER_YELL, ChatMsg.MONSTER_WHISPER,
  ChatMsg.MONSTER_EMOTE, ChatMsg.RAID_BOSS_EMOTE, ChatMsg.RAID_BOSS_WHISPER, ChatMsg.BATTLENET,
]);

/** One decoded line. */
export interface ChatLine {
  type: number;
  /** `CHAT_MSG_<this>` is the event the client's own handler listens for. Null for an unknown byte. */
  eventSuffix: string | null;
  language: number;
  senderGuid: string;
  /** Only the `NAMED_SENDER` types carry a name on the wire; otherwise it is resolved from the guid. */
  senderName: string | null;
  targetGuid: string;
  targetName: string | null;
  /** `CHAT_MSG_CHANNEL` only. */
  channel: string | null;
  text: string;
  /** `chatTag`: 0 none, 1 AFK, 2 DND, 3 GM, 4 mobile. */
  chatTag: number;
  achievementId: number | null;
}

export class ChatMessageHandler extends EventEmitter {
  private game: GameHandler;

  constructor(gameHandler: GameHandler) {
    super();
    this.game = gameHandler;
    this.subscribe('SMSG_MESSAGECHAT', false);
    // `SMSG_GM_MESSAGECHAT` is the same body with the sender's name spliced in as a `u32 len` + string
    // immediately after the flags word, for every type rather than only the monster ones.
    this.subscribe('SMSG_GM_MESSAGECHAT', true);
  }

  /**
   * One arm with the over-read catch, and the residual recorded on BOTH paths.
   *
   * The reason is `object/loot.ts#subscribe`'s: `byte-buffer` THROWS past the frame, and an uncaught
   * throw escapes `GameHandler#dataReceived`'s receive loop, taking every packet still buffered in that
   * data event. This family is where it matters most -- the body is type-dependent, so a wrong arm reads
   * past the end rather than merely misreading a field.
   */
  private subscribe(name: string, isGm: boolean): void {
    this.game.on(`packet:receive:${name}`, (gp: GamePacket) => {
      const bodySize = gp.bodySize;
      try {
        const line = this.decode(gp, isGm);
        chatWire.record({
          opcode: name, bodySize, consumed: gp.index - gp.headerSize, threw: false,
          type: line.type, suffix: line.eventSuffix,
        });
        this.emit('line', line);
      } catch (e) {
        chatWire.record({
          opcode: name, bodySize, consumed: gp.index - gp.headerSize, threw: true,
          type: -1, suffix: null,
        });
        console.warn(`ChatMessageHandler: ${name} decode threw`, e);
      }
    });
  }

  private decode(gp: GamePacket, isGm: boolean): ChatLine {
    const type = gp.readUnsignedByte();
    const language = gp.readUnsignedInt();
    const senderGuid = this.readFullGuid(gp);
    gp.readUnsignedInt(); // flags; every core reads back 0 here
    let senderName: string | null = null;
    let targetGuid = '0x0';
    let targetName: string | null = null;
    let channel: string | null = null;

    if (isGm || NAMED_SENDER.has(type)) {
      senderName = this.readPrefixedString(gp);
      targetGuid = this.readFullGuid(gp);
      // The trailing receiver name is present only for a NON-player, non-pet receiver, and nothing in
      // the bytes says which -- so it is inferred the way the core decides to write it.
      if (targetGuid !== '0x0' && !isPlayerGuid(targetGuid)) {
        targetName = this.readPrefixedString(gp);
      }
    } else if (type === ChatMsg.WHISPER_FOREIGN) {
      senderName = this.readPrefixedString(gp);
      targetGuid = this.readFullGuid(gp);
    } else if (type === ChatMsg.BG_SYSTEM_NEUTRAL || type === ChatMsg.BG_SYSTEM_ALLIANCE
      || type === ChatMsg.BG_SYSTEM_HORDE) {
      targetGuid = this.readFullGuid(gp);
      if (targetGuid !== '0x0' && !isPlayerGuid(targetGuid)) {
        targetName = this.readPrefixedString(gp);
      }
    } else {
      // THE CHANNEL NAME COMES BEFORE THE RECEIVER GUID AND IS A BARE CSTRING with no length prefix --
      // the one string in this packet that is not prefixed, because the core writes it with
      // `<< channelName` on a `char const*`. Reading it as prefixed desyncs the whole rest of the body.
      if (type === ChatMsg.CHANNEL) {
        channel = gp.readCStr();
      }
      targetGuid = this.readFullGuid(gp);
    }

    const text = this.readPrefixedString(gp);
    const chatTag = gp.readUnsignedByte();
    const achievementId = (type === ChatMsg.ACHIEVEMENT || type === ChatMsg.GUILD_ACHIEVEMENT)
      ? gp.readUnsignedInt() : null;

    return {
      type,
      eventSuffix: EVENT_SUFFIX.get(type) ?? null,
      language,
      senderGuid,
      senderName,
      targetGuid,
      targetName,
      channel,
      text,
      chatTag,
      achievementId,
    };
  }

  /**
   * `u32 len` then `len` bytes, **the last of which is the NUL**.
   *
   * THE LENGTH INCLUDES THE TERMINATOR, which the reference states explicitly and which is the trap
   * here: taking `len` characters yields the text plus a stray NUL, and reading a bare cstring without
   * consuming the prefix is four bytes out. Both are silent. A zero length is a real value on the wire
   * for an absent target name, so it is handled rather than treated as malformed.
   */
  private readPrefixedString(gp: GamePacket): string {
    const length = gp.readUnsignedInt();
    if (length === 0) {
      return '';
    }
    let out = '';
    for (let i = 0; i < length; ++i) {
      const byte = gp.readUnsignedByte();
      if (byte !== 0) {
        out += String.fromCharCode(byte);
      }
    }
    return out;
  }

  /** Eight little-endian bytes -> the normalised guid string. FULL, never packed, in this family. */
  private readFullGuid(gp: GamePacket): string {
    const bytes = new Uint8Array(GUID_BYTES);
    for (let i = 0; i < GUID_BYTES; ++i) {
      bytes[i] = gp.readUnsignedByte();
    }
    return guidHex(bytes);
  }

  /**
   * `CMSG_MESSAGECHAT` (0x095): `u32 type, u32 language`, then per type -- a whisper carries the target
   * name first, a channel message the channel name first, everything else just the text. Every string
   * here is a bare cstring; the `u32 len` prefix is the SERVER's form only.
   *
   * NOTE THE TYPE IS `u32` OUTBOUND AND `u8` INBOUND. Not a mistake and not symmetrical:
   * `HandleMessagechatOpcode` reads `uint32 type; uint32 lang;` while `BuildChatPacket` writes
   * `uint8(chatType)`. The dead handler had this one thing right and it is worth keeping from it.
   */
  send(type: number, text: string, target?: string | null, channel?: string | null): void {
    const prefix = type === ChatMsg.WHISPER ? (target ?? '')
      : (type === ChatMsg.CHANNEL ? (channel ?? '') : null);
    const body = 4 + 4 + cstrBytes(prefix) + cstrBytes(text);
    const gp = new GamePacket(GameOpcode.CMSG_MESSAGECHAT, GamePacket.HEADER_SIZE_OUTGOING + body);
    gp.writeUnsignedInt(type);
    // LANG_UNIVERSAL. A race language needs `Languages.dbc` joined to the player's race, which this
    // client does not read; universal is what every server accepts and what a GM client sends.
    gp.writeUnsignedInt(0);
    if (prefix !== null) {
      gp.writeCString(prefix);
    }
    gp.writeCString(text);
    this.game.send(gp);
  }
}

/**
 * Is this guid a PLAYER's? A 3.3.5a guid's high word is its `HighGuid`, and a player's is 0 -- so a
 * player guid has no high word at all, which is why the test is on the string's length.
 *
 * A STRING test rather than a numeric mask, deliberately: `guid-hex.ts` is the single formatter and its
 * own header records that a 64-bit guid does not survive a JS Number. Trimmed of leading zeros, a player
 * guid is at most 8 hex digits after the `0x`.
 */
function isPlayerGuid(guid: string): boolean {
  const digits = guid.startsWith('0x') ? guid.slice(2) : guid;
  return digits.length <= 8;
}

/** The byte cost of `writeCString`, or 0 for a string that is not written. See `object/group.ts`. */
function cstrBytes(value: string | null): number {
  if (value === null) {
    return 0;
  }
  let bytes = 1;
  for (let i = 0; i < value.length; ++i) {
    const c = value.charCodeAt(i);
    if (c <= 0x7f) {
      bytes += 1;
    } else if (c <= 0x7ff) {
      bytes += 2;
    } else if (c <= 0xd7ff || (c >= 0xe000 && c <= 0xffff)) {
      bytes += 3;
    } else {
      bytes += 4;
      ++i;
    }
  }
  return bytes;
}

interface ChatWireRow {
  at: number;
  opcode: string;
  bodySize: number;
  consumed: number;
  threw: boolean;
  type: number;
  suffix: string | null;
}

/** The residual instrument, on `window.chatWire`. Bounded; a log would grow without limit. */
class ChatWire {
  public rows: ChatWireRow[] = [];

  record(row: Omit<ChatWireRow, 'at'>): void {
    this.rows.push({ at: performance.now(), ...row });
    if (this.rows.length > 300) {
      this.rows.splice(0, this.rows.length - 300);
    }
  }

  /** Every arrival whose body was not fully consumed -- i.e. every per-type arm that is wrong. */
  get bad(): ChatWireRow[] {
    return this.rows.filter((r) => r.threw || r.consumed !== r.bodySize);
  }
}

export const chatWire = new ChatWire();
if (typeof window !== 'undefined') {
  (window as never as Record<string, unknown>).chatWire = chatWire;
}

export default ChatMessageHandler;
