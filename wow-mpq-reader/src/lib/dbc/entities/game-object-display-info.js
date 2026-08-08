import * as r from 'restructure';

import { Vec3Float } from '../../types';
import Entity from '../entity';
import StringRef from '../string-ref';

export default Entity({
  id: r.uint32le,
  file: StringRef,
  soundIDs: new r.Array(r.uint32le, 10),
  minBoundingBox: Vec3Float,
  maxBoundingBox: Vec3Float,
  objectEffectPackageID: r.uint32le
});
