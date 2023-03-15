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
  tabID: _restructure["default"].uint32le,
  tierID: _restructure["default"].uint32le,
  columnIndex: _restructure["default"].uint32le,
  spellRankIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 9),
  preqreqTalentIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 3),
  preqreqRanks: new _restructure["default"].Array(_restructure["default"].uint32le, 3),
  flags: _restructure["default"].uint32le,
  requiredSpellID: _restructure["default"].uint32le,
  unknowns: new _restructure["default"].Reserved(_restructure["default"].uint32le, 2)
});
exports["default"] = _default;