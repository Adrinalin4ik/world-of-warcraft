import * as r from 'restructure';

import Nofs from '../nofs';

/**
 * fixed16 is an int16 where 0x7FFF represents 1.0. The ribbon alpha track documents the convention
 * explicitly: 0 is transparent, 0x7FFF opaque.
 */
export const FIXED16_SCALE = 32767;

export const decodeFixed16 = (raw) => raw / FIXED16_SCALE;

/**
 * M2PartTrack<T>, which the wiki also writes as FBlock<T>.
 *
 * Not to be confused with AnimationBlock (M2Track): that is keyed on animation timestamps and its
 * arrays are nested one level deeper, one inner array per animation. This is keyed on a fraction of a
 * single particle's lifetime, and its arrays are flat.
 *
 * @param type - restructure type of each value
 *
 * The export MUST stay an anonymous function expression. react-refresh/babel (enabled via
 * FAST_REFRESH in client/config/webpack.config.js) treats a capitalised top-level function
 * declaration or const as a React component and injects a `$RefreshReg$(...)` call; the refresh
 * runtime isn't present for this module, so that call throws on `undefined.register` and kills
 * the whole M2 import chain. See client/src/wow-data-parser/m2/animation-block.js for the same
 * pattern.
 */
export default function(type) {
  return new r.Struct({
    times: new Nofs(r.int16le),
    values: new Nofs(type),

    keys: function() {
      const count = Math.min(this.times.length, this.values.length);
      const keys = [];

      for (let index = 0; index < count; index++) {
        keys.push({ time: decodeFixed16(this.times[index]), value: this.values[index] });
      }

      return keys;
    }
  });
}
