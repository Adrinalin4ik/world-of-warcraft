import * as r from 'restructure';

import Entity from '../entity';

export default Entity({
  id: r.uint32le,
  smoothFacingChaseRate: r.floatle
});