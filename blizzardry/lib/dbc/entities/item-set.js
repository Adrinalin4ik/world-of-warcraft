"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _localizedStringRef = _interopRequireDefault(require("../localized-string-ref"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  name: _localizedStringRef["default"],
  itemIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 17),
  spellIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 8),
  spellThresholds: new _restructure["default"].Array(_restructure["default"].uint32le, 8),
  requiredSkillID: _restructure["default"].uint32le,
  requiredSkillRank: _restructure["default"].uint32le
});
exports["default"] = _default;