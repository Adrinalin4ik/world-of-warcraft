// jsdom, not node: `network/net/packet.js:4` assigns `window['ByteBuffer']` at module scope, so
// importing a packet at all requires a `window`.
/** @jest-environment jsdom */
import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import { decodeQuestPoi, describeResidual } from '../quest-poi';

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

/**
 * One quest, one POI, two points -- one of them at a NEGATIVE world coordinate.
 *
 * `-8900` is roughly Stormwind's own x, so this is the case that fails silently if the point words are
 * read unsigned: the marker would land at the far edge of the sheet rather than throwing.
 */
const BODY = [
  ...u32(1), // questCount
  ...u32(62), // questId
  ...u32(1), // poiCount
  ...u32(7), // blobIndex
  ...u32(0xffffffff), // objectiveIndex -1
  ...u32(0), // mapId
  ...u32(30), // worldMapAreaId -- Elwynn's `WorldMapArea.id`, measured
  ...u32(0), // floorId
  ...u32(0), // unk3
  ...u32(0), // unk4
  ...u32(2), // pointCount
  ...u32(0xffffdd3c), // x = -8900
  ...u32(500), // y
  ...u32(0xffffdd00), // x = -8960
  ...u32(600), // y
];

/**
 * The happy path -- the body is consumed exactly and the two signed reads come out signed.
 *
 * **This proves SELF-CONSISTENCY and not correctness**, and the distinction is the sharpest recurring
 * lesson on this project: a fixture built from the widths the decoder reads cannot catch a wrong width,
 * which is the most repeated silent defect here. The layout is TrinityCore 3.3.5's and no captured
 * 3.3.5a body has been through it. What this arm does catch is a miscounted loop and an unsigned read
 * of a signed field -- and the second one is why the fixture carries a negative coordinate at all.
 */
test('SMSG_QUEST_POI_QUERY_RESPONSE consumes its body exactly and reads its points signed', () => {
  const reply = decodeQuestPoi(incoming(GameOpcode.SMSG_QUEST_POI_QUERY_RESPONSE, BODY));

  expect(reply.exact).toBe(true);
  expect(reply.residual).toBe(0);
  expect(reply.quests).toHaveLength(1);

  const [poi] = reply.quests[0].pois;
  expect(reply.quests[0].questId).toBe(62);
  expect(poi.worldMapAreaId).toBe(30);
  expect(poi.objectiveIndex).toBe(-1);
  expect(poi.points).toEqual([{ x: -8900, y: 500 }, { x: -8960, y: 600 }]);
});

/**
 * THE DIAGNOSTIC IS FED TWO DELIBERATELY WRONG BODIES, because a fixture that only ever sees correct
 * input is exactly the arm a self-built fixture cannot be.
 *
 * The two cases are the two a residual can distinguish, and the point is that it NAMES which:
 *
 *  - a whole number of bytes per row puts the error INSIDE the row and says by how many;
 *  - a remainder that does not divide by the row count means the stride is right and the header or the
 *    tail moved.
 *
 * The third case -- an over-read, i.e. a stride that is too large -- throws inside the decode before a
 * residual exists, which is why it cannot be expressed as a number and is not asserted here.
 */
test('the residual names where the error is, on both shapes of error', () => {
  expect(describeResidual(0, 1)).toBe('exact');
  // Four bytes over two rows: an inserted word in the POI row.
  expect(describeResidual(8, 2)).toContain('4 per row');
  expect(describeResidual(8, 2)).toContain('should be 36 + points');
  // Not whole: the row stride is right and something outside the rows moved.
  expect(describeResidual(5, 2)).toContain('not whole');
  expect(describeResidual(3, 0)).toContain('header or the tail moved');
});
