"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _chunk = _interopRequireDefault(require("../chunked/chunk"));
var _chunked = _interopRequireDefault(require("../chunked"));
var _mwmo = _interopRequireDefault(require("../chunked/mwmo"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var MPHD = (0, _chunk["default"])({
  flags: _restructure["default"].uint32le,
  skip: new _restructure["default"].Reserved(_restructure["default"].uint32le, 7)
});
var Tile = new _restructure["default"].Struct({
  flags: _restructure["default"].uint32le,
  skip: new _restructure["default"].Reserved(_restructure["default"].uint32le)
});
var MAIN = (0, _chunk["default"])({
  tiles: new _restructure["default"].Array(Tile, 4096)
});
var _default = (0, _chunked["default"])({
  MPHD: MPHD,
  MAIN: MAIN,
  MWMO: _mwmo["default"],
  // TODO: Optional MODF chunk

  flags: function flags() {
    return this.MPHD.flags;
  },
  tiles: function tiles() {
    return this.MAIN.tiles.map(function (tile) {
      return tile.flags;
    });
  }
});
exports["default"] = _default;