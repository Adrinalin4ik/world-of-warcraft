// jsdom, not node: `network/net/packet.js:4` assigns `window['ByteBuffer']` at module scope, so
// importing a packet at all requires a `window`.
/** @jest-environment jsdom */
import EventEmitter from 'events';

import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import { MerchantHandler } from '../merchant';
import { itemWire } from '../../../../game/classes/item-wire';

/**
 * THE VENDOR ROW'S RESIDUAL DISCRIMINATOR, fed two DELIBERATELY WRONG bodies.
 *
 * `CLAUDE.md`: "feed the diagnostic two deliberately wrong bodies: a fixture that only ever sees
 * correct input is the arm a self-built fixture cannot be." That is the whole reason this test exists
 * rather than a decode test -- a decode test builds its body from the same widths the decoder reads, so
 * it proves self-consistency and NOTHING about whether the widths are right. Eleven silent width
 * defects on this project say the instrument has to do that job, so the instrument is what is asserted.
 *
 * `SMSG_LIST_INVENTORY` is `u64 guid, u8 count, count * 8 words`, so only the row term scales with the
 * count and `residual / count` separates a row-level error from a header or trailer one.
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
const GUID = [1, 0, 0, 0, 0, 0, 0, 0];

/** `words` u32s per row -- 8 is the real 3.3.5a stride; 9 fakes a future field being appended. */
function inventory(rowCount: number, words: number, extraTail: number[] = []): number[] {
  const body = [...GUID, rowCount];
  for (let i = 0; i < rowCount; ++i) {
    for (let w = 0; w < words; ++w) {
      body.push(...u32(w === 0 ? i + 1 : 1));
    }
  }
  return [...body, ...extraTail];
}

/** The census row for `SMSG_LIST_INVENTORY`, whatever `itemWire` currently holds. */
function census(): any {
  return itemWire.census().find((r: any) => r.opcode.startsWith('SMSG_LIST_INVENTORY'));
}

it('tells a row-level width error from a header one, and passes a correct body', () => {
  const game = fakeGame();
  const handler = new MerchantHandler(game);

  // 1. THE CORRECT SHAPE. Three rows of eight words: residual 0, and nothing to discriminate.
  game.emit('packet:receive:SMSG_LIST_INVENTORY', incoming(
    GameOpcode.SMSG_LIST_INVENTORY, inventory(3, 8),
  ));
  expect(handler.rows).toHaveLength(3);
  expect(census().worst).toBe(0);
  // A clean packet reports no per-row error, so the census does not surface one at all.
  expect(census().perRow).toBeUndefined();

  // 2. A NINTH WORD PER ROW -- what a future WotLK-style append would look like on the wire. The
  //    decode reads its eight and leaves four bytes per row behind, so the discriminator must say
  //    "inside the row, 4 bytes" rather than merely "12 bytes left over".
  game.emit('packet:receive:SMSG_LIST_INVENTORY', incoming(
    GameOpcode.SMSG_LIST_INVENTORY, inventory(3, 9),
  ));
  expect(census().worst).toBe(12);
  expect(census().perRow).toEqual([4]);

  // 3. ONE STRAY BYTE, rows intact. 1 does not divide by 3, so the residual is NOT per-row and the
  //    discriminator must answer null -- which is what sends the next reader to the header or the
  //    trailer instead of to the row.
  game.emit('packet:receive:SMSG_LIST_INVENTORY', incoming(
    GameOpcode.SMSG_LIST_INVENTORY, inventory(3, 8, [0xff]),
  ));
  expect(census().worst).toBe(12);
  const rows = (itemWire as any).rows ?? [];
  const last = rows[rows.length - 1];
  expect(last.bodySize - last.consumed).toBe(1);
  expect(last.residualPerRow).toBeNull();
});
