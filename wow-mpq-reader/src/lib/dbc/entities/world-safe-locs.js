import * as r from 'restructure';

import { Vec3Float } from '../../types';
import Entity from '../entity';
import LocalizedStringRef from '../localized-string-ref';

export default Entity({
  id: r.uint32le,
  mapID: r.uint32le,
  position: Vec3Float,
  name: LocalizedStringRef
});
