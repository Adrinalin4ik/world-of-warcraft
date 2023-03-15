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
  types: new _restructure["default"].Array(_restructure["default"].uint32le, 8),
  propertyIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 8),
  requiredSkillIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 8),
  actions: new _restructure["default"].Array(_restructure["default"].uint32le, 8)
});
exports["default"] = _default;