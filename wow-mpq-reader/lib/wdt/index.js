"use strict";

function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var r = _interopRequireWildcard(require("restructure"));
var _chunked = _interopRequireDefault(require("../chunked"));
var _chunk = _interopRequireDefault(require("../chunked/chunk"));
var _mwmo = _interopRequireDefault(require("../chunked/mwmo"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function _getRequireWildcardCache(nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || _typeof(obj) !== "object" && typeof obj !== "function") { return { "default": obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj["default"] = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
var MPHD = (0, _chunk["default"])({
  flags: r.uint32le,
  skip: new r.Reserved(r.uint32le, 7)
});
var Tile = new r.Struct({
  flags: r.uint32le,
  skip: new r.Reserved(r.uint32le)
});
var MAIN = (0, _chunk["default"])({
  tiles: new r.Array(Tile, 4096)
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
//# sourceMappingURL=index.js.map