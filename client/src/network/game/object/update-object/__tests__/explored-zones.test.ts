import { ObjectType, PlayerField, getUpdateFieldName } from '../../enums';
import {
  EXPLORED_ZONES_WORDS,
  emptyExploredZones,
  isAreaExplored,
  mergeExploredZones,
} from '../explored-zones';

/**
 * The happy path, and it asserts the RETURN and not only the state.
 *
 * That is the documented defect class this file exists inside: `applyUnitFields` gates its
 * `unit:fields` emit on the flag, and a merge that wrote the bitfield while returning false would
 * leave the world map with an overlay it never learns to draw -- the same shape as the quest-log bug
 * that put "1/25" beside "No Active Quests".
 *
 * Goldshire's `AreaTable.areaBit` is 548, measured on the served `areatable.dbc` (Elwynn Forest is
 * 126, Northshire Valley 125) -- so its bit is word 17, bit 4. A real pair, so the word index and
 * the mask are both exercised rather than only word 0.
 */
test('a discovered area sets its bit and reports the change', () => {
  const zones = emptyExploredZones();
  const GOLDSHIRE_BIT = 548;
  const word = getUpdateFieldName(
    PlayerField.player_explored_zones_1 + (GOLDSHIRE_BIT >>> 5),
    ObjectType.Player,
  );
  const block = { [word]: 1 << (GOLDSHIRE_BIT & 31) };

  expect(isAreaExplored(zones, GOLDSHIRE_BIT)).toBe(false);
  expect(mergeExploredZones(zones, block, ObjectType.Player)).toBe(true);
  expect(isAreaExplored(zones, GOLDSHIRE_BIT)).toBe(true);

  // The same block again is not a change, so a health tick carrying it does not repaint the map.
  expect(mergeExploredZones(zones, block, ObjectType.Player)).toBe(false);

  // A bitless row -- the DBC's -1 -- and one past the end are never explored.
  expect(isAreaExplored(zones, -1)).toBe(false);
  expect(isAreaExplored(zones, EXPLORED_ZONES_WORDS * 32)).toBe(false);
});
