'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _chunked = require('../chunked');

var _chunked2 = _interopRequireDefault(_chunked);

var _chunk = require('../chunked/chunk');

var _chunk2 = _interopRequireDefault(_chunk);

var _mwmo = require('../chunked/mwmo');

var _mwmo2 = _interopRequireDefault(_mwmo);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

var MPHD = (0, _chunk2.default)({
  flags: r.uint32le,
  skip: new r.Reserved(r.uint32le, 7)
});

var Tile = new r.Struct({
  flags: r.uint32le,
  skip: new r.Reserved(r.uint32le)
});

var MAIN = (0, _chunk2.default)({
  tiles: new r.Array(Tile, 4096)
});

exports.default = (0, _chunked2.default)({
  MPHD: MPHD,
  MAIN: MAIN,
  MWMO: _mwmo2.default,
  // TODO: Optional MODF chunk

  flags: function () {
    return this.MPHD.flags;
  },

  tiles: function () {
    return this.MAIN.tiles.map(function (tile) {
      return tile.flags;
    });
  }
});
module.exports = exports['default'];