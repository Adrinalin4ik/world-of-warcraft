// jsdom, not node: `network/net/packet.js:4` assigns `window['ByteBuffer']` at module scope, so
// importing a packet at all requires a `window`.
/** @jest-environment jsdom */
import EventEmitter from 'events';

import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import { AuraHandler } from '../auras';
import { auraWire, diagnose } from '../../../../game/classes/aura-wire';

/**
 * THE AURA LAYOUT, AND THE DIAGNOSTIC THAT NAMES ITS ERRORS.
 *
 * **THIS IS SELF-CONSISTENCY, NOT VERIFICATION, and it says so.** The fixture below is built from the
 * widths `auras.ts` reads, so it cannot catch a wrong width -- which is this project's most repeated
 * defect class (`CLAUDE.md`: eleven-plus instances, every one silent). Only a residual against real
 * traffic settles the layout, and that is `window.auraWire.census()` on a live login: a correct read of
 * this family closes to residual **zero**, because the packet has no optional tail to excuse a
 * remainder.
 *
 * What this test DOES settle is the half a self-built fixture can: that the two CONDITIONAL blocks --
 * the caster guid suppressed by `AFLAG_CASTER`, the duration pair gated by `AFLAG_DURATION` -- are read
 * in the right combinations, that a spell id of 0 is a removal with nothing after it, and above all
 * **that the diagnostic names an error rather than only reporting one**. Two deliberately wrong bodies
 * are fed to it for exactly the reason `CLAUDE.md` gives: a diagnostic that only ever sees correct input
 * is the arm a self-built fixture cannot be.
 */

function fakeGame(): any {
  const game: any = new EventEmitter();
  game.world = { entities: new Map(), player: { guid: '0x1' } };
  game.sent = [];
  game.send = (p: GamePacket) => game.sent.push(p);
  return game;
}

function incoming(opcode: number, body: number[]): GamePacket {
  const gp = new GamePacket(opcode, GamePacket.HEADER_SIZE_INCOMING + body.length, false);
  gp.index = gp.headerSize;
  for (const byte of body) {
    gp.writeUnsignedByte(byte);
  }
  gp.index = gp.headerSize;
  return gp;
}

/** A packed guid: one mask byte then the non-zero bytes, low first. `0x0f` = the low four are present. */
const packed = (low: number) => [0x0f, low & 0xff, (low >> 8) & 0xff, (low >> 16) & 0xff, (low >> 24) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

const AFLAG_CASTER = 0x08;
const AFLAG_POSITIVE = 0x10;
const AFLAG_DURATION = 0x20;
const AFLAG_NEGATIVE = 0x80;

test('SMSG_AURA_UPDATE_ALL reads its variable-stride entries and closes to residual zero', () => {
  auraWire.clear();
  const game = fakeGame();
  const handler = new AuraHandler(game);

  const body = [
    ...packed(0x1234),
    // Slot 0: self-cast (no caster guid) WITH a duration -- 20000 ms max, 12500 ms left.
    0, ...u32(1784), AFLAG_CASTER | AFLAG_POSITIVE | AFLAG_DURATION, 60, 1, ...u32(20000), ...u32(12500),
    // Slot 3: cast by someone else (a caster guid follows), NO duration, 5 stacks, harmful.
    3, ...u32(589), AFLAG_NEGATIVE, 70, 5, ...packed(0xabcd),
    // Slot 7: a REMOVAL. Five bytes and nothing after them.
    7, ...u32(0),
  ];

  game.emit('packet:receive:SMSG_AURA_UPDATE_ALL', incoming(GameOpcode.SMSG_AURA_UPDATE_ALL, body));

  const rows = handler.forUnit('0x1234');
  expect(rows.map((r) => [r.slot, r.spellId, r.applications, r.caster])).toEqual([
    [0, 1784, 1, null],
    [3, 589, 5, '0xabcd'],
  ]);
  // The duration pair is SECONDS and an ABSOLUTE expiry; a permanent aura's expiry is null, never 0,
  // because 0 is truthy in Lua and `duration > 0 and expirationTime` would then arm a countdown.
  expect(rows[0].duration).toBe(20);
  expect(rows[0].expiresAt).not.toBeNull();
  expect(rows[1].duration).toBe(0);
  expect(rows[1].expiresAt).toBeNull();
  // Three entries read, and the body consumed WHOLE.
  const census = auraWire.census() as Array<{ opcode: string; entries: number; residuals: string[] }>;
  expect(census).toEqual([
    expect.objectContaining({
      opcode: 'SMSG_AURA_UPDATE_ALL',
      entries: 3,
      residuals: ['closed:0'],
    }),
  ]);

  // A single `SMSG_AURA_UPDATE` merges into the same unit rather than replacing it, and spell id 0
  // clears one slot.
  game.emit('packet:receive:SMSG_AURA_UPDATE', incoming(GameOpcode.SMSG_AURA_UPDATE, [
    ...packed(0x1234), 3, ...u32(0),
  ]));
  expect(handler.forUnit('0x1234').map((r) => r.slot)).toEqual([0]);
  // The server sets exactly one of POSITIVE/NEGATIVE on every path, so the fallback must never be hit.
  expect(handler.unclassified).toBe(0);
  // The cancel send: `u32 spellId` and nothing else.
  handler.cancelAura(1784);
  expect(game.sent).toHaveLength(1);
  expect(game.sent[0].opcode).toBe(GameOpcode.CMSG_CANCEL_AURA);
  expect(game.sent[0].bodySize).toBe(4);
});

test('the residual diagnostic NAMES the error, on two deliberately wrong bodies', () => {
  // The three answers the plain "here is a number" residual cannot give, checked directly -- because a
  // residual that only ever sees a correct body is the arm that proves nothing.
  //
  // A per-entry width error: 4 entries, each read 3 bytes short (a `u8` where a `u32` sits).
  expect(diagnose(100, 88, 4, false)).toEqual({ residual: 12, perEntry: 3, kind: 'per-entry' });
  // A moved header or tail: the entries closed, 5 bytes are left, and 5 does not divide by 4.
  expect(diagnose(100, 95, 4, false)).toEqual({ residual: 5, perEntry: null, kind: 'header-or-tail' });
  // An over-read, which no arithmetic on `consumed` can express -- the decode died inside byte-buffer.
  expect(diagnose(100, 100, 4, true)).toEqual({ residual: 0, perEntry: null, kind: 'over-read' });

  // And the real thing: a body that lies about its flags. This claims a duration on the LAST entry and
  // supplies neither word, so the read runs past the frame and `subscribe` catches it as `!THREW`.
  auraWire.clear();
  const game = fakeGame();
  new AuraHandler(game);
  game.emit('packet:receive:SMSG_AURA_UPDATE_ALL', incoming(GameOpcode.SMSG_AURA_UPDATE_ALL, [
    ...packed(0x77),
    0, ...u32(1784), AFLAG_CASTER | AFLAG_POSITIVE | AFLAG_DURATION, 60, 1, /* no duration words */
  ]));
  expect((auraWire.census() as Array<{ opcode: string }>)[0].opcode)
    .toBe('SMSG_AURA_UPDATE_ALL!THREW');

  // A body that omits the caster guid the flags say is there: the entry's own bytes are consumed out of
  // the NEXT entry, so the loop ends with a remainder that does not divide by the entries it read --
  // `header-or-tail`, which is the diagnostic saying "the stride is not what you think" rather than
  // reporting a bare number.
  auraWire.clear();
  const game2 = fakeGame();
  new AuraHandler(game2);
  game2.emit('packet:receive:SMSG_AURA_UPDATE_ALL', incoming(GameOpcode.SMSG_AURA_UPDATE_ALL, [
    ...packed(0x77),
    // AFLAG_CASTER is NOT set, so a packed guid is expected -- and the four bytes that follow are the
    // start of what was meant to be a second entry.
    0, ...u32(1784), AFLAG_POSITIVE, 60, 1,
    1, ...u32(2458), AFLAG_POSITIVE | AFLAG_CASTER, 60, 1,
  ]));
  const census = auraWire.census() as Array<{ residuals: string[] }>;
  expect(census[0].residuals[0]).not.toBe('closed:0');
});
