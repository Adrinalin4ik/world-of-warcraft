import * as r from 'restructure';

import { Vec3Float } from '../../types';
import Entity from '../entity';

export default Entity({
  id: r.uint32le,
  mapID: r.uint32le,
  position: Vec3Float,
  radius: r.floatle,
  box: new r.Struct({
    length: r.floatle,
    width: r.floatle,
    height: r.floatle,
    yaw: r.floatle
  })
});
