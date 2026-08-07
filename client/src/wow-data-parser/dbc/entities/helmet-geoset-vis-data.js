import * as r from 'restructure';

import Entity from '../entity';

/**
 * What a worn helm hides. `ItemDisplayInfo` fields 13/14 index this per sex.
 *
 * Measured on the live 3.3.5a host (`dbfilesclient/helmetgeosetvisdata.dbc`): **21 records, 8 fields,
 * 32-byte stride** -- an id plus SEVEN masks, so `hideGeosets` is 7 long and not 5. Each mask is a
 * RACE BITFIELD (`1 << ChrRaces.id`), not a geoset id: a set bit means "for this race, force that
 * region slot back to its base". Columns 0..4 are the hair and three facial-hair groups and the ears,
 * verified in the reference against the client's consumer at `0x4799a0`
 * (`benilla-formats/src/characters/geosets.rs:28-31`).
 *
 * Columns 5 and 6 are carried but NOT consumed -- four of the 21 rows (285, 370, 371, 376) have a
 * non-zero one and which slot they address is not settled by anything measured. See
 * `ui/scene/character-equipment.ts#HELM_FORCED_SLOTS` for the measured values and the consequence.
 */
export default Entity({
  id: r.uint32le,
  hideGeosets: new r.Array(r.uint32le, 7)
});
