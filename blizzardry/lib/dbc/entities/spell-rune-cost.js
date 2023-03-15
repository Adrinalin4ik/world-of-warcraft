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
  bloodRuneCost: _restructure["default"].uint32le,
  unholyRuneCost: _restructure["default"].uint32le,
  frostRuneCost: _restructure["default"].uint32le,
  runePowerGain: _restructure["default"].uint32le
});
exports["default"] = _default;