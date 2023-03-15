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
  bounds: new _restructure["default"].Struct({
    left: _restructure["default"].uint32le,
    right: _restructure["default"].uint32le,
    top: _restructure["default"].uint32le,
    bottom: _restructure["default"].uint32le
  }),
  offsetX: _restructure["default"].floatle,
  offsetY: _restructure["default"].floatle,
  scale: _restructure["default"].floatle,
  taxiMinX: _restructure["default"].floatle,
  taxiMinY: _restructure["default"].floatle,
  taxiMaxX: _restructure["default"].floatle,
  taxiMaxY: _restructure["default"].floatle,
  worldMapID: _restructure["default"].uint32le
});
exports["default"] = _default;