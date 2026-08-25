import * as r from 'restructure';

import Entity from '../entity';

// `dbfilesclient/durabilitycosts.dbc`, MEASURED on the served file rather than transcribed:
// `recordCount 300`, `fieldCount 30`, `recordSize 120`, `stringSize 1` -- an empty string block,
// which is itself a check that every column is numeric.
//
// `1 + 21 + 8 = 30`, exactly the file's `fieldCount`: the layout closes with nothing left over, which
// is the strongest check a DBC layout gets. The split into 21 weapon and 8 armor multipliers is
// TrinityCore 3.3.5's `DurabilityCostsEntry` (`shared/DataStores/DBCStructure.h:599-604`) -- a SERVER
// implementation, labelled as such -- and the served bytes corroborate it in four independent places:
// at item level 300 the multipliers are
//
//     weapon[9]  = 0   the obsolete weapon subclass
//     armor[0]   = 0   ITEM_SUBCLASS_ARMOR_MISC -- rings, necks and trinkets have no durability
//     armor[5]   = 0   the obsolete buckler
//     armor[7]   = 0   librams and relics have no durability
//
// and every zero lands exactly where a subclass with nothing to repair must be. The two-handers are
// also the expensive ones (`weapon[1]` axe2H, `[5]` mace2H, `[8]` sword2H, `[10]` staff all 808
// against `[0]` axe1H's 539), and thrown is the cheapest at 54.
//
// The KEY is the item's own item level: row `n` is item level `n`, 1..300.
export default Entity({
  id: r.uint32le,
  weaponSubClassCost: new r.Array(r.uint32le, 21),
  armorSubClassCost: new r.Array(r.uint32le, 8)
});
