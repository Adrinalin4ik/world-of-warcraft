// jsdom, not node: `network/net/packet.js:4` assigns `window['ByteBuffer']` at module scope, so
// importing a packet at all requires a `window`.
/** @jest-environment jsdom */
import EventEmitter from 'events';

import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import { QuestHandler } from '../quest';

/**
 * THE QUEST TEMPLATE CONSUMES ITS PACKET EXACTLY, AND ITS THREE STRINGS COME OUT IN THE RIGHT ORDER.
 *
 * `SMSG_QUEST_QUERY_RESPONSE` is the one quest packet the log cannot work without and the one with the
 * most arithmetic in front of its strings: 27 scalars, then 4x2 + 6x2 reward words, then three
 * five-long reputation arrays, then a point block -- 116 bytes of prefix before the title. **An
 * off-by-one anywhere in that count lands the title inside a number**, and the visible result is a
 * plausible-looking log row rather than an error.
 *
 * So this test asserts two things and only two:
 *
 *  1. **The residual is zero.** A body built to the documented 3.3.5a layout is consumed exactly, which
 *     is what proves the fixed array counts (4/6/5/4/6) and the WotLK insertions add up. This is
 *     self-consistency, NOT verification against a real server -- the layouts come from TrinityCore
 *     3.3.5 and `object/quest.ts`' header says plainly that no live 3.3.5a packet has been decoded yet.
 *     What it does catch is the class of defect a re-read of the arm cannot: a miscounted loop.
 *  2. **`title, objectives, details` in that order** -- objectives BEFORE details, reversed from the
 *     accept panel. Both strings are non-empty on every real quest, so swapping them puts the
 *     description in the objectives line and looks fine.
 *
 * And it covers `readCStr` at the same time: `endText` and `completedText` and all four objective texts
 * are EMPTY here, which is the case `byte-buffer`'s own `readCString` gets wrong by one byte each. Six
 * empty strings means a `readCString` decode would finish six bytes short and the residual would be 6.
 */

function fakeGame(): any {
  const game: any = new EventEmitter();
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

const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const cstr = (s: string) => [...Array.from(s, (c) => c.charCodeAt(0)), 0];

test('SMSG_QUEST_QUERY_RESPONSE consumes its body exactly and orders its strings', () => {
  const game = fakeGame();
  const handler = new QuestHandler(game);

  const body: number[] = [
    ...u32(18), // questId
    ...u32(2), // method
    ...u32(3), // level
    ...u32(1), // minLevel -- WotLK
    ...u32(9), // zoneOrSort (Elwynn)
    ...u32(0), // type
    ...u32(0), // suggestedPlayers
    ...u32(0), ...u32(0), // repObjectiveFaction/Value
    ...u32(0), ...u32(0), // repObjectiveFaction2/Value2 -- WotLK
    ...u32(0), // nextQuestInChain
    ...u32(0), // xpId -- WotLK
    ...u32(250), // rewOrReqMoney
    ...u32(0), // rewMoneyMaxLevel
    ...u32(0), // rewSpell
    ...u32(0), // rewSpellCast
    ...u32(0), // rewHonorAddition -- WotLK
    ...u32(0), // rewHonorMultiplier (f32 0.0) -- WotLK
    ...u32(0), // srcItemId
    ...u32(8), // flags
    ...u32(0), // charTitleId
    ...u32(0), // playersSlain -- WotLK
    ...u32(0), // bonusTalents -- WotLK
    ...u32(0), // rewArenaPoints -- WotLK
    ...u32(0), // unk -- WotLK
    // 4 reward pairs
    ...u32(1234), ...u32(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    // 6 choice pairs
    ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    // 3 x 5 reputation arrays
    ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0), // poi continent/x/y/opt
    ...cstr('Brotherhood of Thieves'),
    ...cstr('Kill 8 Defias Thugs.'),
    ...cstr('Marshal McBride needs help.'),
    ...cstr(''), // endText -- EMPTY, the readCStr case
    ...cstr(''), // completedText -- EMPTY, WotLK's fifth string
    // 4 objective quads
    ...u32(3383), ...u32(8), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    // 6 required-item pairs
    ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    // 4 objective texts, all EMPTY
    ...cstr(''), ...cstr(''), ...cstr(''), ...cstr(''),
  ];

  game.emit(
    'packet:receive:SMSG_QUEST_QUERY_RESPONSE',
    incoming(GameOpcode.SMSG_QUEST_QUERY_RESPONSE, body),
  );

  const template = handler.templates.get(18);
  expect(template).toBeDefined();
  // (1) The residual. `exact` is `consumed === bodySize`, computed in the arm itself.
  expect(template!.exact).toBe(true);
  // (2) The string order -- objectives BEFORE details on this wire.
  expect(template!.title).toBe('Brotherhood of Thieves');
  expect(template!.objectivesText).toBe('Kill 8 Defias Thugs.');
  expect(template!.details).toBe('Marshal McBride needs help.');
  // The objective quad landed where it should, which is only true if the strings ended where expected.
  expect(template!.objectives[0].creatureOrGo).toBe(3383);
  expect(template!.objectives[0].requiredCount).toBe(8);
  expect(template!.rewards[0]).toEqual({ itemId: 1234, count: 1 });
});

/**
 * EVERY OUTGOING BODY IS THE WIDTH 3.3.5a's OWN `Read()` CONSUMES.
 *
 * The owner: "Принять квест тоже не получается" -- the Accept button enabled, the click doing nothing.
 * `CMSG_QUESTGIVER_ACCEPT_QUEST` was going out at **12 bytes** where TrinityCore 3.3.5's
 * `HandleQuestgiverAcceptQuestOpcode` reads `guid >> questId >> startCheat` -- **16**. A short body
 * makes the server's `ByteBuffer` read past the end and throw; the packet is discarded and NOTHING
 * comes back, so the gesture is inert rather than refused. Eleven-plus instances of this class already
 * in this project, every one silent.
 *
 * This asserts the whole family at once rather than only the one that broke, because the sharp edge is
 * that `ACCEPT` needs 16 while `COMPLETE_QUEST` and `REQUEST_REWARD` -- the two that shared its helper
 * -- genuinely need 12. Widening the helper would have fixed one and broken two, equally silently.
 *
 * Asserted at the SEND, which is this client's whole half: accept has no acknowledgement at all (the
 * descriptor slot is the only confirmation), so there is no reply to assert against and a test that
 * waited for one would hang on a protocol that never answers.
 */
test('every outgoing quest body is the width 3.3.5a reads', () => {
  const game = fakeGame();
  const handler = new QuestHandler(game);
  const npc = '0xf130000337003477';

  // The accept needs a giver, which `queryQuest` latches. 13 bytes: guid + questId + a u8 startCheat,
  // which is 12 in 1.12 -- the same family, a different width, and both are checked here.
  handler.queryQuest(18, npc);
  handler.acceptQuest(18);
  handler.completeQuest(18);
  handler.requestReward(18);
  handler.chooseReward(0, 18);
  handler.removeQuest(3);
  handler.cancel();
  handler.queryTemplate(4242);

  const bodies = game.sent.map((p: GamePacket) => ({
    opcode: p.opcode,
    body: p.length - GamePacket.HEADER_SIZE_OUTGOING,
  }));
  const widthOf = (opcode: number) => bodies.find((b: { opcode: number }) => b.opcode === opcode)?.body;

  expect(widthOf(GameOpcode.CMSG_QUESTGIVER_QUERY_QUEST)).toBe(13);
  // THE ONE THAT BROKE. 8 + 4 + 4.
  expect(widthOf(GameOpcode.CMSG_QUESTGIVER_ACCEPT_QUEST)).toBe(16);
  // And the two that must STAY at 12, which is why the helper was not widened.
  expect(widthOf(GameOpcode.CMSG_QUESTGIVER_COMPLETE_QUEST)).toBe(12);
  expect(widthOf(GameOpcode.CMSG_QUESTGIVER_REQUEST_REWARD)).toBe(12);
  expect(widthOf(GameOpcode.CMSG_QUESTGIVER_CHOOSE_REWARD)).toBe(16);
  expect(widthOf(GameOpcode.CMSG_QUESTLOG_REMOVE_QUEST)).toBe(1);
  expect(widthOf(GameOpcode.CMSG_QUESTGIVER_CANCEL)).toBe(0);
  expect(widthOf(GameOpcode.CMSG_QUEST_QUERY)).toBe(4);
});
