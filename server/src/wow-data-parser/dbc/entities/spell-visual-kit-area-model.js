import * as r from 'restructure';

import Entity from '../entity';
import StringRef from '../string-ref';

export default Entity({
  id: r.uint32le,
  name: StringRef,
  enumID: r.uint32le
});