import * as r from 'restructure';

import { Vec3Float } from '../../types';
import Entity from '../entity';

export default Entity({
  id: r.uint32le,
  transportID: r.uint32le,
  timeIndex: r.uint32le,
  position: Vec3Float,
  sequenceID: r.uint32le
});
