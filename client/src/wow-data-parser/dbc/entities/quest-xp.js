import * as r from 'restructure';

import Entity from '../entity';

// `dbfilesclient/questxp.dbc`, MEASURED on the served file: `recordCount 100`, `fieldCount 11`,
// `recordSize 44`, `stringSize 1`, and the layout closes exactly against the 4421 bytes served
// (20 + 100*44 + 1).
//
// **The KEY is the QUEST's level, not a quest id** -- row `n` is quest level `n`, 1..100. The ten
// `difficulty` words are the XP for that level at each difficulty band, and the quest template's
// `xpId` (`SMSG_QUEST_QUERY_RESPONSE`'s `xpId`) selects one of them. Columns 0 and 9 are always 0 in
// the served data, which is what the field documentation says of them too (wowdev DB/QuestXP).
//
// CORROBORATED against real traffic rather than trusted, and the cross-check is exact: the owner's
// giver panel showed "Experience: 40" for quest 783, a level-1 quest, and row 1 decodes as
// `[0, 10, 20, 40, 60, 80, 100, 120, 160, 0]` -- so 40 is `difficulty[3]`, and the amount the SERVER
// computed and sent is the same word this indexing picks. Row 61 reads
// `[0, 970, 2400, 4850, 7300, 9800, 12200, 14700, 19600, 0]`, monotonically increasing across the
// bands, which is what a difficulty ladder must be.
export default Entity({
  id: r.uint32le,
  difficulty: new r.Array(r.uint32le, 10)
});
