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

/**
 * A GIVER PANEL NAMES THE QUEST, so the log can list it before `CMSG_QUEST_QUERY` answers.
 *
 * The owner's log read **"Quests: 1/25"** beside **"No Active Quests"**: the header counts the
 * descriptor and the list was built from the TEMPLATE cache, so a query that had not answered -- or
 * whose answer was lost -- produced a count with no rows, an unopenable row and an empty objectives
 * tracker, all from one gap.
 *
 * Two things are asserted, and both are what make that impossible rather than merely unlikely:
 *
 *  1. `SMSG_QUESTGIVER_QUEST_DETAILS` seeds `titles`, so the quest the player just accepted is
 *     nameable with no round trip.
 *  2. A template decode that THROWS releases the in-flight id, so the quest can be asked for again on
 *     the next descriptor edge. It used to stay in `queried` for ever, which made one bad decode a
 *     permanently missing row.
 */
test('a giver panel seeds the title, and a failed template query stays retryable', () => {
  const game = fakeGame();
  const handler = new QuestHandler(game);
  const npc = '0xf130000337003477';

  // The accept panel, in the 3.3.5a shape: two guids, then the id and the three strings.
  const guid8 = [0x77, 0x34, 0x00, 0x37, 0x03, 0x00, 0x30, 0xf1];
  handler.queryQuest(18, npc);
  game.emit('packet:receive:SMSG_QUESTGIVER_QUEST_DETAILS', incoming(
    GameOpcode.SMSG_QUESTGIVER_QUEST_DETAILS,
    [
      // The sharer guid is a FULL u64 -- eight bytes, not four. Writing it short made the decode read
      // the quest id out of the title ("Brot" = 1953460802), which is the fixture making the same class
      // of mistake the layouts themselves are guarded against.
      ...guid8, ...u32(0), ...u32(0), ...u32(18),
      ...cstr('Brotherhood of Thieves'), ...cstr('Bandanas, please.'), ...cstr('Bring 8.'),
      0, ...u32(0), ...u32(0), 0,
      ...u32(0), // no choices
      ...u32(0), // no rewards
      ...u32(0), // money
      ...u32(250), // xp
    ],
  ));
  expect(handler.details?.questId).toBe(18);
  // (1) The title is now known WITHOUT the template.
  expect(handler.templates.has(18)).toBe(false);
  expect(handler.titles.get(18)).toBe('Brotherhood of Thieves');

  // (2) A truncated query response throws inside the arm; the id must still be released.
  handler.queryTemplate(4242);
  expect(game.sent.some((p: GamePacket) => p.opcode === GameOpcode.CMSG_QUEST_QUERY)).toBe(true);
  const before = game.sent.length;
  game.emit('packet:receive:SMSG_QUEST_QUERY_RESPONSE', incoming(
    GameOpcode.SMSG_QUEST_QUERY_RESPONSE, [...u32(4242), ...u32(2)],
  ));
  expect(handler.templates.has(4242)).toBe(false);
  // Retryable: the second ask goes out, where before the `queried` entry blocked it for ever.
  handler.queryTemplate(4242);
  expect(game.sent.length).toBe(before + 1);
});
