import * as r from 'restructure';

import Entity from '../entity';
import StringRef from '../string-ref';

export default Entity({
  id: r.uint32le,
  name: StringRef,
  file: StringRef,
  /**
   * Whether a WIDESCREEN companion of `file` exists, spelled `<file>Wide.blp`.
   *
   * Measured on the served `LoadingScreens.dbc` (91 records, 4 fields, 16-byte rows): the column is 1
   * for `Kalimdor` and `Azeroth` and 0 for the instance screens -- and
   * `interface/glues/loadingscreens/loadscreenkalimdorwide.blp` really is served, 700,236 B, the same
   * length as `loadscreenkalimdor.blp` but with DIFFERENT bytes. So the column names a real second
   * file rather than a flag with no consequence. Verified live: the resolver picked
   * `LoadScreenEasternKingdomWide.blp` for map 0 at 1382x911. **The NAME is ours** -- the DBC ships no
   * column names.
   */
  hasWideScreen: r.uint32le
});
