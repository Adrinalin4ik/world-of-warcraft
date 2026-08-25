/**
 * QUEST POINTS OF INTEREST -- `SMSG_QUEST_POI_QUERY_RESPONSE` (**0x1E4**), the map's quest markers.
 *
 * This is the half the world map could not draw. `WorldMapFrame_DisplayQuestPOI` asks
 * `QuestPOIGetIconInfo(questId)` for a position (`worldmapframe.lua:1711`) and `WorldMapBlobFrame`
 * asks for the shaded objective areas; neither is in a DBC and neither is in the descriptor. They come
 * from one query and nothing else, which is why "Show Quest Objectives" and "quests on the map" were
 * one gap rather than two.
 *
 * ## The request
 *
 * `CMSG_QUEST_POI_QUERY` (**0x1E3**) is a `u32` count followed by that many quest ids -- one packet for
 * the whole log rather than one per quest, which is why this file batches instead of copying
 * `queryTemplate`'s per-id dedupe.
 *
 * ## The reply, and WHAT IS NOT VERIFIED ABOUT IT
 *
 * **The layout below is TrinityCore 3.3.5's `SendQuestPOIQueryResponse` and it has NOT been through a
 * residual against captured traffic.** This project's most repeated silent defect is a field that
 * widened between 1.12 and 3.3.5a, and the only thing that has ever settled one is decoding a real
 * body and asserting nothing is left over. So `decodeQuestPoi` reports `exact` and, when it is false,
 * **names where the error is** rather than only that there is one -- see `describeResidual`. Until a
 * real packet has been through it, the right word for this layout is *self-consistent*.
 *
 *     u32  questCount
 *     per quest:
 *       u32  questId
 *       u32  poiCount
 *       per poi:
 *         u32  blobIndex          -- the POI's own id, and the blob's key
 *         i32  objectiveIndex     -- which objective this marks; -1 for the quest as a whole
 *         u32  mapId              -- `Map.dbc` id
 *         u32  worldMapAreaId     -- `WorldMapArea.id`, which is what the position is relative to
 *         u32  floorId
 *         u32  unk3
 *         u32  unk4
 *         u32  pointCount
 *         per point:
 *           i32 x                 -- world coordinates, the same space as the player's position
 *           i32 y
 *
 * `x`/`y` are SIGNED and that is not cosmetic: half of Azeroth is at negative world coordinates, so
 * reading them unsigned puts every marker in Kalimdor's north-west corner.
 *
 * ## Cost
 *
 * One packet for the whole log, and the reply is a few hundred bytes per quest at most. Decoded once
 * into plain objects and read by index -- no allocation on the map's own update path, which matters
 * because `WorldMapFrame_DisplayQuestPOI` runs per quest per open.
 */
import GamePacket from '../packet';

/** One point of a POI's polygon. World coordinates, signed. */
export interface PoiPoint {
  x: number;
  y: number;
}

/** One point of interest for one quest. */
export interface QuestPoi {
  /** The POI's own id -- `WorldMapBlobFrame`'s key for the shaded area. */
  blobIndex: number;
  /** Which objective this marks, or -1 for the quest as a whole. */
  objectiveIndex: number;
  mapId: number;
  /** `WorldMapArea.id`. The points are world coordinates inside THIS area's rect. */
  worldMapAreaId: number;
  floorId: number;
  /**
   * The two words this client has no name for, kept rather than skipped.
   *
   * Naming them "unk3"/"unk4" is TrinityCore's own naming and is honest: skipping them would make the
   * stride right by accident and leave nothing to look at when the residual says the row is wrong.
   */
  unk3: number;
  unk4: number;
  points: PoiPoint[];
}

export interface QuestPoiSet {
  questId: number;
  pois: QuestPoi[];
}

export interface QuestPoiReply {
  quests: QuestPoiSet[];
  /** Whether the body was consumed exactly. False means the layout above is wrong for this server. */
  exact: boolean;
  /** Bytes left over. 0 when `exact`. */
  residual: number;
}

/**
 * Words in one POI header, before its points. Used by `describeResidual` to turn a leftover byte count
 * into a statement about WHERE the error is.
 */
const POI_HEADER_WORDS = 8;

/**
 * Turn a residual into a sentence that NAMES the error instead of only reporting one.
 *
 * The rule this project settled on for a `header + count * stride + tail` body: divide the remainder by
 * the wire count. A whole number puts the error INSIDE the row and says by how many bytes -- a `u8`
 * read where a `u32` sits is +3, an inserted word +4. A non-whole remainder means the stride is right
 * and the header or the tail moved. An over-read throws before reaching here, which is the third case
 * and the one neither of the others can express.
 */
export function describeResidual(residual: number, poiCount: number): string {
  if (residual === 0) {
    return 'exact';
  }
  if (poiCount <= 0) {
    return `${residual} bytes left over with no POI rows -- the header or the tail moved`;
  }
  const perRow = residual / poiCount;
  return Number.isInteger(perRow)
    ? `${residual} bytes over ${poiCount} rows = ${perRow} per row`
      + ` -- the POI stride is ${POI_HEADER_WORDS * 4} + points and should be ${
        POI_HEADER_WORDS * 4 + perRow} + points`
    : `${residual} bytes over ${poiCount} rows is not whole`
      + ' -- the row stride is right and the header or the tail moved';
}

/**
 * Decode a `SMSG_QUEST_POI_QUERY_RESPONSE` body.
 *
 * Reads the counts from the wire and trusts them, which is what makes the residual meaningful: a
 * fixture built from the widths this function reads would prove self-consistency and nothing else.
 */
export function decodeQuestPoi(gp: GamePacket): QuestPoiReply {
  const questCount = gp.readUnsignedInt() >>> 0;
  const quests: QuestPoiSet[] = [];
  let poiRows = 0;

  for (let q = 0; q < questCount; q += 1) {
    const questId = gp.readUnsignedInt() >>> 0;
    const poiCount = gp.readUnsignedInt() >>> 0;
    const pois: QuestPoi[] = [];
    for (let p = 0; p < poiCount; p += 1) {
      poiRows += 1;
      const poi: QuestPoi = {
        blobIndex: gp.readUnsignedInt() >>> 0,
        // SIGNED: -1 is "the quest as a whole" and reading it unsigned gives 4294967295.
        objectiveIndex: gp.readInt(),
        mapId: gp.readUnsignedInt() >>> 0,
        worldMapAreaId: gp.readUnsignedInt() >>> 0,
        floorId: gp.readUnsignedInt() >>> 0,
        unk3: gp.readUnsignedInt() >>> 0,
        unk4: gp.readUnsignedInt() >>> 0,
        points: [],
      };
      const pointCount = gp.readUnsignedInt() >>> 0;
      for (let i = 0; i < pointCount; i += 1) {
        // SIGNED, and this is the one that would fail quietly: half of Azeroth is at negative world
        // coordinates, so unsigned reads put those markers in the far north-west of the sheet.
        poi.points.push({ x: gp.readInt(), y: gp.readInt() });
      }
      pois.push(poi);
    }
    quests.push({ questId, pois });
  }

  const residual = gp.bodySize - (gp.index - gp.headerSize);
  if (residual !== 0) {
    console.warn(
      'quest-poi: SMSG_QUEST_POI_QUERY_RESPONSE -- '
      + `${describeResidual(residual, poiRows)}. The layout in network/game/object/quest-poi.ts is`
      + ' TrinityCore 3.3.5 and has not been checked against this server.',
    );
  }
  return { quests, exact: residual === 0, residual };
}
