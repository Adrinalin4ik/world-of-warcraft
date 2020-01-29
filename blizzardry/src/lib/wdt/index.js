import r from 'restructure';

import Chunk from '../chunked/chunk';
import Chunked from '../chunked';
import MWMO from '../chunked/mwmo';

const MPHD = Chunk({
  flags: r.uint32le,
  skip: new r.Reserved(r.uint32le, 7)
});

const Tile = new r.Struct({
  flags: r.uint32le,
  skip: new r.Reserved(r.uint32le)
});

const MAIN = Chunk({
  tiles: new r.Array(Tile, 4096)
});

export default Chunked({
  MPHD: MPHD,
  MAIN: MAIN,
  MWMO: MWMO,
  // TODO: Optional MODF chunk

  flags: function() {
    return this.MPHD.flags;
  },

  tiles: function() {
    return this.MAIN.tiles.map(function(tile) {
      return tile.flags;
    });
  }
});
