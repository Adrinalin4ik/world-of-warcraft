"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  mapID: _restructure["default"].uint32le,
  regionMinX: _restructure["default"].floatle,
  regionMinY: _restructure["default"].floatle,
  regionMaxX: _restructure["default"].floatle,
  regionMaxY: _restructure["default"].floatle,
  newMapID: _restructure["default"].uint32le,
  regionOffsetX: _restructure["default"].floatle,
  regionOffsetY: _restructure["default"].floatle,
  unknown: new _restructure["default"].Reserved(_restructure["default"].uint32le)
});
exports["default"] = _default;