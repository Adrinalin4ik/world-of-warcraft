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
  skillLineID: _restructure["default"].uint32le,
  raceMask: _restructure["default"].uint32le,
  classMask: _restructure["default"].uint32le,
  flags: _restructure["default"].uint32le,
  requiredLevel: _restructure["default"].uint32le,
  skillTierID: _restructure["default"].uint32le,
  skillCostID: _restructure["default"].uint32le
});
exports["default"] = _default;