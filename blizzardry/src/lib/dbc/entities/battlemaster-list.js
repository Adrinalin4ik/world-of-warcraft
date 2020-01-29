import r from 'restructure';

import Entity from '../entity';
import LocalizedStringRef from '../localized-string-ref';

export default Entity({
  id: r.uint32le,
  instanceIDs: new r.Array(r.int32le, 8),
  type: r.uint32le,
  minLevel: r.uint32le,
  maxLevel: r.uint32le,
  teamSize: r.uint32le,
  unknowns: new r.Reserved(r.uint32le, 3),
  name: LocalizedStringRef,
  unknowns2: new r.Reserved(r.uint32le, 2)
});
