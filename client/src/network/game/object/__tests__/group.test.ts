/**
 * The two paths that carry the owner's first two asks, on the wire.
 *
 * HAPPY PATH ONLY and two tests, per the project's test rule. The first is the one thing no reasoning
 * settles -- that `CMSG_GROUP_INVITE`'s body is the name and the trailing word and nothing else, at the
 * right length -- because `GameHandler#send` derives the declared packet length from the BUFFER, so an
 * over-allocated body ships a wrong length field and the server answers with silence. The second is the
 * roster decode, which is the one layout in this family with a variable-length block in the middle: if
 * the member rows are read wrong, the leader guid after them is garbage and `IsPartyLeader` is wrong
 * for reasons nothing at the Lua end can explain.
 */
import EventEmitter from 'events';

import { GroupHandler } from '../group';
import GameOpcode from '../../opcode';
import GamePacket from '../../packet';

/** A `GameHandler` stand-in: the event bus the handler subscribes to, plus a `send` spy. */
function fakeGame() {
  const bus = new EventEmitter() as EventEmitter & { send: jest.Mock };
  bus.send = jest.fn();
  return bus;
}

/** Build an INCOMING packet from a body, positioned as `GameHandler` hands one over. */
function incoming(body: number[]): GamePacket {
  const gp = new GamePacket(0, GamePacket.HEADER_SIZE_INCOMING + body.length, false);
  gp.index = GamePacket.HEADER_SIZE_INCOMING;
  gp.write(body);
  gp.index = GamePacket.HEADER_SIZE_INCOMING;
  return gp;
}

const cstr = (s: string): number[] => [...Array.from(s, (c) => c.charCodeAt(0)), 0];
const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (low: number): number[] => [...u32(low), 0, 0, 0, 0];

describe('GroupHandler', () => {
  it('sends CMSG_GROUP_INVITE as the name plus one word, sized exactly', () => {
    const game = fakeGame();
    const handler = new GroupHandler(game as never);

    handler.invite('Fdsh');

    expect(game.send).toHaveBeenCalledTimes(1);
    const sent: GamePacket = game.send.mock.calls[0][0];
    expect(sent.opcode).toBe(GameOpcode.CMSG_GROUP_INVITE);
    // "Fdsh" + NUL + u32 = 9 bytes. An over-allocated buffer would report more and ship a wrong length.
    expect(sent.bodySize).toBe(9);
    sent.index = sent.headerSize;
    expect(sent.readCStr()).toBe('Fdsh');
    expect(sent.readUnsignedInt()).toBe(0);
  });

  it('decodes SMSG_GROUP_LIST past the variable member block to the leader guid', () => {
    const game = fakeGame();
    const handler = new GroupHandler(game as never);
    const roster: number[] = [
      0x00, 0x00, 0x00, 0x00, // groupType (party), our subgroup, our flags, our roles
      ...u64(0xaa), // group guid
      ...u32(7), // 3.3 counter
      ...u32(1), // one member besides us
      ...cstr('Gesf'), ...u64(0x22), 0x01, 0x00, 0x00, 0x00, // name, guid, online, subgroup, flags, roles
      ...u64(0x22), // leader guid -- the member, not us
      0x03, ...u64(0x22), 0x04, 0x02, 0x01, 0x00, // loot method/looter/threshold/dungeon/raid/dynamic
    ];

    game.emit('packet:receive:SMSG_GROUP_LIST', incoming(roster));

    expect(handler.members).toHaveLength(1);
    expect(handler.members[0].name).toBe('Gesf');
    expect(handler.members[0].online).toBe(true);
    // The three fields AFTER the variable block -- the ones a mis-sized member row corrupts.
    expect(handler.leaderGuid).toBe('0x22');
    expect(handler.lootThreshold).toBe(4);
    expect(handler.dungeonDifficulty).toBe(2);
  });
});
