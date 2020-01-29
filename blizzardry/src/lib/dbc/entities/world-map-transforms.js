import r from 'restructure';

import Entity from '../entity';

export default Entity({
  id: r.uint32le,
  mapID: r.uint32le,
  regionMinX: r.floatle,
  regionMinY: r.floatle,
  regionMaxX: r.floatle,
  regionMaxY: r.floatle,
  newMapID: r.uint32le,
  regionOffsetX: r.floatle,
  regionOffsetY: r.floatle,
  unknown: new r.Reserved(r.uint32le)
});
