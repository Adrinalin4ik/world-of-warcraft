import * as r from 'restructure';

import Entity from '../entity';

// SIGNED, and that is a real distinction rather than tidiness: measured over the served
// `dbfilesclient/spellduration.dbc` (130 records, 4 fields, recordSize 16), **row 21 carries
// `baseDuration` and `maxDuration` of -1** and row 427 carries -600000. Read as `uint32le`, -1 becomes
// 4294967295 ms and a `$d` token in a spell description prints "4294967.295 sec" -- a number that reads
// as truth. -1 is the engine's "no natural end", which the client's own
// `SPELL_DURATION_UNTIL_CANCELLED = "until cancelled"` (`globalstrings.lua:6937`) is the string for; see
// `pipeline/dbc/spell-data.ts#durationMs`.
export default Entity({
  id: r.uint32le,
  baseDuration: r.int32le,
  perLevel: r.int32le,
  maxDuration: r.int32le
});
