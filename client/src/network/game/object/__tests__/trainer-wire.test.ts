// jsdom, not node: `network/net/packet.js:4` assigns `window['ByteBuffer']` at module scope, so
// importing a packet at all requires a `window`.
/** @jest-environment jsdom */
import EventEmitter from 'events';

import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import { TrainerHandler } from '../trainer';
import { spellWire } from '../../../../game/classes/spell-wire';

/**
 * THE TRAINER LIST DECODES WHOLE, AND THE BUY GOES OUT BY SPELL ID.
 *
 * Two assertions and no more, on the two things that can be wrong in a way that still looks fine:
 *
 *  1. **The residual.** `SMSG_TRAINER_LIST`'s row is 38 bytes, derived twice (see
 *     `object/trainer.ts`' header), and the layout comes from a SERVER implementation. `consumed`
 *     against `bodySize` is the only oracle for it, and the body here is built from the same field
 *     sizes the decoder reads -- so a stride error shows as a nonzero remainder rather than as prices
 *     that happen to look plausible.
 *  2. **The empty greeting.** `byte-buffer`'s `readCString` does not consume an EMPTY string's
 *     terminator, which has corrupted two decodes on this project. The second service's row is placed
 *     BEFORE a zero-length greeting on purpose, so a `readCString` here would leave the residual at 1.
 *
 * The buy is asserted at the SEND because that is the whole of this client's half, and because it is
 * the arm that was deliberately not exercised live (buying costs the owner gold).
 */

function fakeGame(): any {
  const game: any = new EventEmitter();
  game.sent = [];
  game.send = (p: GamePacket) => game.sent.push(p);
  return game;
}

/** An INCOMING packet whose body is `body`, positioned as `dataReceived` would leave it. */
function incoming(opcode: number, body: number[]): GamePacket {
  const gp = new GamePacket(opcode, GamePacket.HEADER_SIZE_INCOMING + body.length, false);
  gp.index = gp.headerSize;
  for (const byte of body) {
    gp.writeUnsignedByte(byte);
  }
  gp.index = gp.headerSize;
  return gp;
}

const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const full = (low: number) => [...u32(low), 0, 0, 0, 0];

/** One 38-byte service row. */
const row = (spellId: number, state: number, cost: number, level: number) => [
  ...u32(spellId),
  state,
  ...u32(cost),
  ...u32(0), // profDialog
  ...u32(0), // profButton
  level,
  ...u32(0), // reqSkill
  ...u32(0), // reqSkillValue
  ...u32(0), ...u32(0), ...u32(0), // reqSpell[3]
];

test('SMSG_TRAINER_LIST consumes its body whole, empty greeting and all', () => {
  spellWire.clear();
  const game = fakeGame();
  const handler = new TrainerHandler(game);

  const body = [
    ...full(0x3ab1),
    ...u32(0), // trainerType: class
    ...u32(2), // count
    ...row(78, 0, 100, 1), // Heroic Strike, available, 1 copper... 100 copper, level 1
    ...row(2457, 2, 0, 10), // Battle Stance, already known, free, level 10
    0, // the greeting, EMPTY -- see the header
  ];
  // The size is an arithmetic identity, and asserting it here is what makes the residual meaningful:
  // 8 + 4 + 4 + 2*38 + 1.
  expect(body.length).toBe(93);

  game.emit(
    'packet:receive:SMSG_TRAINER_LIST',
    incoming(GameOpcode.SMSG_TRAINER_LIST, body),
  );

  const listRow = spellWire.history().find((r) => r.kind === 'TRAINER_LIST');
  expect(listRow).toBeDefined();
  expect(listRow!.consumed).toBe(listRow!.bodySize);

  expect(handler.source).toBe('0x3ab1');
  expect(handler.greeting).toBe('');
  expect(handler.services.map((s) => [s.spellId, s.state, s.moneyCost, s.reqLevel])).toEqual([
    [78, 0, 100, 1],
    [2457, 2, 0, 10],
  ]);
  // The padding is dropped, so this length IS `GetTrainerServiceNumAbilityReq`.
  expect(handler.services[0].reqSpells).toEqual([]);
});

test('BuyTrainerService sends CMSG_TRAINER_BUY_SPELL addressed by spell id', () => {
  const game = fakeGame();
  const handler = new TrainerHandler(game);

  // No trainer open: nothing goes out. This is the arm that makes the next one mean something.
  handler.buy(78);
  expect(game.sent).toHaveLength(0);

  game.emit('packet:receive:SMSG_TRAINER_LIST', incoming(GameOpcode.SMSG_TRAINER_LIST, [
    ...full(0x3ab1), ...u32(0), ...u32(1), ...row(78, 0, 100, 1), 0,
  ]));
  handler.buy(78);

  expect(game.sent).toHaveLength(1);
  const sent: GamePacket = game.sent[0];
  expect(sent.opcode).toBe(GameOpcode.CMSG_TRAINER_BUY_SPELL);
  sent.index = GamePacket.HEADER_SIZE_OUTGOING;
  const guidBytes = Array.from({ length: 8 }, () => sent.readUnsignedByte());
  expect(guidBytes).toEqual(full(0x3ab1));
  expect(sent.readUnsignedInt() >>> 0).toBe(78);
});
