// jsdom, not node: `network/net/packet.js:4` assigns `window['ByteBuffer']` at module scope, so
// importing a packet at all requires a `window`.
/** @jest-environment jsdom */
import EventEmitter from 'events';

import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import { CombatHandler } from '../combat';

/**
 * LOSING THE TARGET CANCELS AUTO-ATTACK ON THE WIRE.
 *
 * The owner: "Автоатака должна отменяться если цели нет или она сброшена esc."
 *
 * Asserted at the SEND, because that is the whole of this client's half: the button and the combat
 * pose are driven by the server's `SMSG_ATTACKSTOP` reply and not written locally, so "did the UI
 * clear" is a question about `handleAttackStop`, which already had its own path. What was missing was
 * that nothing ever asked the server to stop.
 *
 * One test, not four: `Esc`, a click on empty ground, the target dying and the target streaming out
 * all reach this method through the single `World#setTarget(null)` door, so they are the same code
 * path and enumerating them would test the caller, not this.
 */

function fakeGame(): any {
  const game: any = new EventEmitter();
  game.world = { entities: new Map(), player: { guid: '0x59a6' } };
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

/** Eight little-endian bytes -- `SMSG_ATTACKSTART` carries FULL guids (`attack.rs:16-18`). */
const full = (low: number, high: number) => [low, high, 0, 0, 0, 0, 0, 0];

test('clearing the target sends CMSG_ATTACKSTOP, and only when we were attacking', () => {
  const game = fakeGame();
  const handler = new CombatHandler(game);

  // Pick a target. No attack is running, so nothing but the selection goes out.
  handler.select('0x1234');
  expect(game.sent.map((p: GamePacket) => p.opcode)).toEqual([GameOpcode.CMSG_SET_SELECTION]);

  // A DESELECT WITH NO ATTACK RUNNING MUST BE QUIET -- otherwise every click on empty ground would
  // send a stop. This is the arm that makes the next one mean something.
  game.sent.length = 0;
  handler.select(null);
  expect(game.sent.map((p: GamePacket) => p.opcode)).toEqual([GameOpcode.CMSG_SET_SELECTION]);

  // Now the server says WE have entered auto-attack -- attacker is our own guid.
  handler.select('0x1234');
  game.sent.length = 0;
  game.emit(
    'packet:receive:SMSG_ATTACKSTART',
    incoming(GameOpcode.SMSG_ATTACKSTART, [...full(0xa6, 0x59), ...full(0x34, 0x12)]),
  );

  // Losing the target now cancels it, and the stop precedes the selection so the server never sees a
  // swing at a target we have already given up.
  handler.select(null);
  expect(game.sent.map((p: GamePacket) => p.opcode))
    .toEqual([GameOpcode.CMSG_ATTACKSTOP, GameOpcode.CMSG_SET_SELECTION]);
});
