"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = new _restructure["default"].Struct({
  x: _restructure["default"].floatle,
  y: _restructure["default"].floatle,
  z: _restructure["default"].floatle,
  w: _restructure["default"].floatle
});
exports["default"] = _default;