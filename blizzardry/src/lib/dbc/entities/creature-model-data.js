import r from 'restructure';

import Entity from '../entity';
import StringRef from '../string-ref';

export default Entity({
  id: r.uint32le,
  flags: r.uint32le,
  file: StringRef,
  sizeClass: r.uint32le,
  scale: r.floatle,
  bloodID: r.int32le,

  skips: new r.Reserved(r.uint32le, 22)
});
