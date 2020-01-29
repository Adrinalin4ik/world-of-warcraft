'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _chunk = require('../chunked/chunk');

var _chunk2 = _interopRequireDefault(_chunk);

var _chunked = require('../chunked');

var _chunked2 = _interopRequireDefault(_chunked);

var _mwmo = require('../chunked/mwmo');

var _mwmo2 = _interopRequireDefault(_mwmo);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var MPHD = (0, _chunk2.default)({
  flags: _restructure2.default.uint32le,
  skip: new _restructure2.default.Reserved(_restructure2.default.uint32le, 7)
});

var Tile = new _restructure2.default.Struct({
  flags: _restructure2.default.uint32le,
  skip: new _restructure2.default.Reserved(_restructure2.default.uint32le)
});

var MAIN = (0, _chunk2.default)({
  tiles: new _restructure2.default.Array(Tile, 4096)
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