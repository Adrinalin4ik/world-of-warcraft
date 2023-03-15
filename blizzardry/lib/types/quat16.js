"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = new _restructure["default"].Struct({
  x: _restructure["default"].uint16le,
  y: _restructure["default"].uint16le,
  z: _restructure["default"].uint16le,
  w: _restructure["default"].uint16le
});
exports["default"] = _default;