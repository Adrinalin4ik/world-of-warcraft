import * as r from 'restructure';

import Entity from '../entity';

// `dbfilesclient/durabilityquality.dbc`, MEASURED on the served file: `recordCount 16`,
// `fieldCount 2`, `recordSize 8`, `stringSize 1`. 149 bytes whole.
//
// `data` is a FLOAT, not an integer -- reading it as `uint32le` yields 1065353216 for 1.0, which would
// multiply every repair cost by a billion. The served values, decoded as floats, are
//
//     id  1  1.0     id  2  0.6     id  3  1.0     id  4  0.8
//     id  5  1.0     id  6  1.0     id  7  1.2     id  8  1.25
//     id  9  1.44    id 10  2.5     id 11  1.728   id 12  3.0
//     id 13  0.0     id 14  0.0     id 15  1.2     id 16  1.25
//
// The row a repair uses is `(quality + 1) * 2` (TrinityCore 3.3.5 `Item::CalculateDurabilityRepairCost`,
// `Entities/Item/Item.cpp:771` -- a SERVER implementation, labelled as such), and that indexing is
// corroborated by the data: it selects ids 2, 4, 6, 8, 10, 12 for qualities 0..5, whose values are
// 0.6, 0.8, 1.0, 1.25, 2.5, 3.0 -- monotonically increasing from poor to legendary, which is what a
// quality modifier must be. The odd ids are the unused half of the table.
export default Entity({
  id: r.uint32le,
  data: r.floatle
});
