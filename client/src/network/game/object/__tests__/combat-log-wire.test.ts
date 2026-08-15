// jsdom, not node: `network/net/packet.js:4` assigns `window['ByteBuffer']` at module scope, so
// importing a packet at all requires a `window`.
/** @jest-environment jsdom */
import EventEmitter from 'events';

import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import { CombatLogHandler } from '../combat-log';
import { combatLogWire } from '../../../../game/classes/combat-wire';

/**
 * THE TWO PACKETS THE OWNER'S COMPLAINT RESTS ON, decoded to a residual of ZERO.
 *
 * `consumed == bodySize` is the whole check, and it is the only one these layouts can have: they come
 * from a SERVER implementation (see `combat-log.ts`' header) and no DBC or FrameXML file states a
 * packet body. The discipline is `spells-wire.test.ts`' and before that `combatWire`'s, both written
 * after a transcribed 1.12 layout put every field of `SMSG_ATTACKERSTATEUPDATE` past the third at the
 * wrong offset while the feature still looked like it worked.
 *
 * These two are chosen because they are the two the round is FOR -- a spell's damage number and a
 * spell's dodge -- and because they exercise the two different guid conventions in the family: the
 * damage log packs both guids and the miss log carries both FULL, which is the same genuine
 * disagreement `SMSG_ATTACKSTART` and `SMSG_ATTACKSTOP` already have in `combat.ts`. Reading either
 * the other's way desyncs, and a zero residual is what rules that out.
 *
 * `SMSG_PERIODICAURALOG` is deliberately NOT tested: its trailing `critical u8` is unverified (no
 * periodic tick has ever been observed on this project's wire -- the live roster owns no DoT), and a
 * test written from the same unverified assumption as the code would only restate it. That gap is
 * named in `combat-text.ts#spellText` instead.
 */

/** A minimal stand-in for `GameHandler`: the emitter the handler subscribes to, plus an empty world. */
function fakeGame(): any {
  const game: any = new EventEmitter();
  game.world = { entities: new Map(), player: null };
  game.send = () => {};
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

const u32 = (value: number) => [
  value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * A packed guid: a mask byte whose bit `i` marks a non-zero byte `i`, then those bytes low-first --
 * `network/net/packet.js:98`. `0x1234` is bytes 0x34 and 0x12, i.e. mask 0b11.
 */
const packed = (low: number, high: number) => [0b11, low, high];

/** Eight little-endian bytes. */
const full = (low: number, high: number) => [low, high, 0, 0, 0, 0, 0, 0];

test('SMSG_SPELLNONMELEEDAMAGELOG decodes whole and announces the damage', () => {
  const game = fakeGame();
  const handler = new CombatLogHandler(game);
  combatLogWire.clear();

  const events: any[] = [];
  handler.on('spell:damage', (ev: any) => events.push(ev));

  // target 0x1234 · caster 0x5678 · spell 331 (Healing Wave's id, any id will do) · damage 42 ·
  // overkill 0 · school 0x04 (SCHOOL_MASK_NATURE) · absorb 0 · resist 0 · periodic 0 · unused 0 ·
  // blocked 0 · hitInfo 0x2 (SPELL_HIT_TYPE_CRIT) · extendedData 0.
  const body = [
    ...packed(0x34, 0x12),
    ...packed(0x78, 0x56),
    ...u32(331),
    ...u32(42),
    ...u32(0),
    0x04,
    ...u32(0),
    ...u32(0),
    0,
    0,
    ...u32(0),
    ...u32(0x2),
    0,
  ];
  game.emit(
    'packet:receive:SMSG_SPELLNONMELEEDAMAGELOG',
    incoming(GameOpcode.SMSG_SPELLNONMELEEDAMAGELOG, body),
  );

  const rows = combatLogWire.history();
  expect(rows).toHaveLength(1);
  // THE RESIDUAL. Anything but 0 means the layout does not close on a body built from it.
  expect(rows[0].bodySize - rows[0].consumed).toBe(0);
  expect(events).toHaveLength(1);
  expect(events[0].amount).toBe(42);
  expect(events[0].school).toBe(0x04);
  expect(events[0].crit).toBe(true);
});

test('SMSG_SPELLLOGMISS decodes whole and announces a DODGE', () => {
  const game = fakeGame();
  const handler = new CombatLogHandler(game);
  combatLogWire.clear();

  const events: any[] = [];
  handler.on('spell:miss', (ev: any) => events.push(ev));

  // spell 331 · caster 0x5678 FULL · useExtended 0 · count 1 · target 0x1234 FULL · missInfo 3.
  // `SpellMissInfo` 3 is DODGE -- the same numbering `WORD_KEY` is indexed by, which is what makes a
  // spell's dodge and a swing's dodge print the same word.
  const body = [
    ...u32(331),
    ...full(0x78, 0x56),
    0,
    ...u32(1),
    ...full(0x34, 0x12),
    3,
  ];
  game.emit('packet:receive:SMSG_SPELLLOGMISS', incoming(GameOpcode.SMSG_SPELLLOGMISS, body));

  const rows = combatLogWire.history();
  expect(rows).toHaveLength(1);
  expect(rows[0].bodySize - rows[0].consumed).toBe(0);
  expect(rows[0].missCode).toBe(3);
  expect(events).toHaveLength(1);
  expect(events[0].code).toBe(3);
});
