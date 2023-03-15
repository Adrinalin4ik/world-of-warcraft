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
  castTime: _restructure["default"].uint32le,
  castTimePerLevel: _restructure["default"].floatle,
  minCastTime: _restructure["default"].uint32le
});
exports["default"] = _default;