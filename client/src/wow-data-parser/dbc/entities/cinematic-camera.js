import * as r from 'restructure';

import { Vec3Float } from '../../types';
import Entity from '../entity';
import StringRef from '../string-ref';

export default Entity({
  id: r.uint32le,
  file: StringRef,
  voiceoverID: r.uint32le,
  position: Vec3Float,
  rotation: r.floatle
});
