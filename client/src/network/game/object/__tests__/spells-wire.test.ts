// jsdom, not node: `network/net/packet.js:4` assigns `window['ByteBuffer']` at module scope, so
// importing a packet at all requires a `window`.
/** @jest-environment jsdom */
import EventEmitter from 'events';

import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import { MAX_ACTION_BUTTONS, SpellHandler } from '../spells';
import { spellWire } from '../../../../game/classes/spell-wire';

/**
 * The two entry-burst packets, decoded at the sizes they were actually recorded at.
 *
 * `SMSG_INITIAL_SPELLS` was measured at **329 B** and `SMSG_ACTION_BUTTONS` at **577 B** in a real entry
 * capture, and each size has exactly one small solution under the 3.3.5a layouts:
 *
 *   329 = 1 (unk) + 2 (spellCount) + 6 * 54 (u32 spellId + u16 unk) + 2 (cooldownCount) + 14 * 0
 *   577 = 1 (packetType) + 4 * 144 (packed slot words)
 *
 * So the test builds bodies of exactly those sizes and asserts the decode consumes them WHOLE. That is
 * the check that matters -- `consumed == bodySize` -- and it is the same discipline `combatWire` was
 * built on after a transcribed 1.12 layout put every field of `SMSG_ATTACKERSTATEUPDATE` past the third
 * at the wrong offset while the feature still looked like it worked.
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

const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number) => [
  value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff,
];

test('SMSG_INITIAL_SPELLS (329 B) and SMSG_ACTION_BUTTONS (577 B) decode whole', () => {
  const handler = new SpellHandler(fakeGame());
  spellWire.clear();

  // -- 54 known spells, no cooldowns. 6603 is Auto Attack, 78 Heroic Strike.
  const spellIds = [6603, 78];
  while (spellIds.length < 54) {
    spellIds.push(1000 + spellIds.length);
  }
  const spellsBody = [0, ...u16(spellIds.length)];
  for (const id of spellIds) {
    spellsBody.push(...u32(id), ...u16(0));
  }
  spellsBody.push(...u16(0)); // cooldownCount
  expect(spellsBody.length).toBe(329);

  (handler as any).handleInitialSpells(incoming(GameOpcode.SMSG_INITIAL_SPELLS, spellsBody));

  // -- 144 slots. Slot 1 holds Auto Attack, slot 2 Heroic Strike, both as ACTION_BUTTON_SPELL (type 0);
  //    slot 3 holds a MACRO (type 0x40), which must NOT be reported as a spell.
  const slots = new Array<number>(MAX_ACTION_BUTTONS).fill(0);
  slots[0] = 6603;
  slots[1] = 78;
  slots[2] = 5 | (0x40 << 24);
  const buttonsBody = [0];
  for (const packed of slots) {
    buttonsBody.push(...u32(packed));
  }
  expect(buttonsBody.length).toBe(577);

  (handler as any).handleActionButtons(incoming(GameOpcode.SMSG_ACTION_BUTTONS, buttonsBody));

  // BOTH bodies consumed to the last byte. A wrong layout lands somewhere arbitrary instead.
  const rows = spellWire.history();
  expect(rows.map((row) => [row.kind, row.bodySize, row.consumed])).toEqual([
    ['INITIAL_SPELLS', 329, 329],
    ['ACTION_BUTTONS', 577, 577],
  ]);

  expect(handler.knownSpells().size).toBe(54);
  expect(handler.knownSpells().has(6603)).toBe(true);
  expect(handler.spellInSlot(1)).toBe(6603);
  expect(handler.spellInSlot(2)).toBe(78);
  // A macro is not a spell: the high byte is the TYPE, and only type 0 is castable here.
  expect(handler.spellInSlot(3)).toBeNull();
  expect(handler.spellInSlot(4)).toBeNull();
});
