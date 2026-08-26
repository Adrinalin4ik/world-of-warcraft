/**
 * The two things about `SMSG_MESSAGECHAT` that no amount of reasoning settles.
 *
 * HAPPY PATH ONLY and two tests, per the project's test rule.
 *
 * The first is the length-prefixed string, because it is wrong in two silent directions: the `u32 len`
 * INCLUDES the NUL, so taking `len` characters yields a trailing zero byte, and skipping the prefix to
 * read a bare cstring is four bytes out. Either way the text looks nearly right and the residual is the
 * only witness -- so the test asserts the residual too.
 *
 * The second is `CHAT_MSG_CHANNEL`, the one arm whose string is NOT length-prefixed and which sits
 * BEFORE the receiver guid. Getting that order or that form wrong desyncs everything after it, and it
 * is the arm the old dead handler hardcoded to a five-character channel name.
 */
import EventEmitter from 'events';

import { ChatMessageHandler, ChatMsg, chatWire } from '../chat';
import GamePacket from '../../packet';

function fakeGame() {
  const bus = new EventEmitter() as EventEmitter & { send: jest.Mock };
  bus.send = jest.fn();
  return bus;
}

/** An INCOMING packet positioned as `GameHandler` hands one over. */
function incoming(body: number[]): GamePacket {
  const gp = new GamePacket(0, GamePacket.HEADER_SIZE_INCOMING + body.length, false);
  gp.index = GamePacket.HEADER_SIZE_INCOMING;
  gp.write(body);
  gp.index = GamePacket.HEADER_SIZE_INCOMING;
  return gp;
}

const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (low: number): number[] => [...u32(low), 0, 0, 0, 0];
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
/** The wire form: `u32 len` where len COUNTS THE NUL, then the bytes, then the NUL. */
const prefixed = (s: string): number[] => [...u32(s.length + 1), ...ascii(s), 0];

describe('SMSG_MESSAGECHAT', () => {
  /**
   * A CYRILLIC BODY, which came out as `Ð Ð°Ð·...` in the owner's chat.
   *
   * The body is UTF-8 on the wire; the old reader built the string one byte at a time, which is
   * Latin-1. `utf8` below encodes the way the server does, so a byte-per-character read cannot pass
   * this -- it would answer twice as many characters.
   */
  it('decodes a UTF-8 body rather than one byte per character', () => {
    const game = fakeGame();
    const handler = new ChatMessageHandler(game as never);
    const lines: unknown[] = [];
    handler.on('line', (line) => lines.push(line));
    const text = 'Разящий';
    const utf8 = Array.from(new TextEncoder().encode(text));

    game.emit('packet:receive:SMSG_MESSAGECHAT', incoming([
      ChatMsg.SAY,
      ...u32(0),
      ...u64(0x22),
      ...u32(0),
      ...u64(0),
      ...u32(utf8.length + 1), ...utf8, 0,
      0x00,
    ]));

    expect((lines[0] as { text: string }).text).toBe(text);
  });

  it('decodes a say, consuming the length-prefixed text exactly', () => {
    const game = fakeGame();
    const handler = new ChatMessageHandler(game as never);
    const lines: unknown[] = [];
    handler.on('line', (line) => lines.push(line));
    const before = chatWire.rows.length;

    game.emit('packet:receive:SMSG_MESSAGECHAT', incoming([
      ChatMsg.SAY,
      ...u32(0), // language: universal
      ...u64(0x22), // sender guid, FULL
      ...u32(0), // flags
      ...u64(0), // receiver guid (the default arm)
      ...prefixed('hello there'),
      0x00, // chatTag
    ]));

    expect(lines).toHaveLength(1);
    const line = lines[0] as { text: string; eventSuffix: string; senderGuid: string };
    expect(line.text).toBe('hello there');
    expect(line.eventSuffix).toBe('SAY');
    expect(line.senderGuid).toBe('0x22');
    // The residual is the real assertion: a body not fully consumed means the layout is wrong even
    // when the text happens to come out readable.
    const row = chatWire.rows[before];
    expect(row.threw).toBe(false);
    expect(row.consumed).toBe(row.bodySize);
  });

  it('decodes a channel message, whose channel name is a bare cstring before the guid', () => {
    const game = fakeGame();
    const handler = new ChatMessageHandler(game as never);
    const lines: unknown[] = [];
    handler.on('line', (line) => lines.push(line));
    const before = chatWire.rows.length;

    game.emit('packet:receive:SMSG_MESSAGECHAT', incoming([
      ChatMsg.CHANNEL,
      ...u32(0),
      ...u64(0x31),
      ...u32(0),
      ...ascii('General'), 0, // the channel name: NO length prefix, and it comes FIRST
      ...u64(0),
      ...prefixed('anyone here'),
      0x00,
    ]));

    expect(lines).toHaveLength(1);
    const line = lines[0] as { channel: string; text: string; eventSuffix: string };
    expect(line.channel).toBe('General');
    expect(line.text).toBe('anyone here');
    expect(line.eventSuffix).toBe('CHANNEL');
    const row = chatWire.rows[before];
    expect(row.consumed).toBe(row.bodySize);
  });
});
