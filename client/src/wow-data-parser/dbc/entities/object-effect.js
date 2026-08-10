import * as r from 'restructure';

import { Vec3Float } from '../../types';
import Entity from '../entity';
import StringRef from '../string-ref';

export default Entity({
  id: r.uint32le,
  name: StringRef,
  effectGroupID: r.uint32le,
  triggerType: r.uint32le,
  eventType: r.uint32le,
  effectRecType: r.uint32le,
  effectRecID: r.uint32le,
  attachment: r.uint32le,
  offset: Vec3Float,
  effectModifierID: r.uint32le
});
