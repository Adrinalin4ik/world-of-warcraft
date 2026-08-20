import * as r from 'restructure';

import Entity from '../entity';
import LocalizedStringRef from '../localized-string-ref';

/**
 * `Faction.dbc`, 3.3.5a (build 12340).
 *
 * **THIS DEFINITION WAS FOUR FIELDS SHORT AND READ THE NAME FROM THE WRONG COLUMN.** It declared
 * id + index + 4 + 4 + 4 + 4 + parentID + 17 + 17 = **53** fields, and the served file's own header says
 * **57** (`recordCount 401`, `fieldCount 57`, `recordSize 228`, `stringBlock 17339`, and
 * 20 + 401*228 + 17339 = 108787 = the exact file size, which is the strongest check a DBC layout gets).
 *
 * The four missing columns are 3.3.5's `parentFactionMod[2]` and `parentFactionCap[2]`, which sit BETWEEN
 * `parentID` and the name. MEASURED on the served bytes rather than inferred from the count:
 *
 *     field 19 (where `name` used to start) -> 0, i.e. an empty string, for every row
 *     field 23                              -> 'PLAYER, Human', 'Booty Bay', 'Wailing Caverns', ...
 *     field 40                              -> the descriptions
 *     field 19 also reads 1065353216, which is the IEEE-754 bit pattern for 1.0 -- so it is a float,
 *       not a string offset, and `parentFactionMod` is confirmed as `float[2]`
 *
 * `parentID` (field 18) resolves to a real faction id for all 401 rows, 0 exceptions, which pins the
 * front half of the record. 105 rows carry `index >= 0` (max 104) -- those are the ones the reputation
 * pane can show, and they are what `SMSG_INITIALIZE_FACTIONS`' 128 slots are indexed by.
 *
 * Nothing read this table until the reputation work, which is why a wrong name column had no symptom.
 */
export default Entity({
  id: r.uint32le,
  index: r.int32le,
  raceMask: new r.Array(r.uint32le, 4),
  classMask: new r.Array(r.uint32le, 4),
  reputationBase: new r.Array(r.int32le, 4),
  reputationFlags: new r.Array(r.uint32le, 4),
  parentID: r.uint32le,
  // 3.3.5 additions, and their absence is what shifted the name by four columns.
  parentFactionMod: new r.Array(r.floatle, 2),
  parentFactionCap: new r.Array(r.uint32le, 2),
  name: LocalizedStringRef,
  description: LocalizedStringRef
});
