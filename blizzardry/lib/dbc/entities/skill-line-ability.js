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
  spellID: _restructure["default"].uint32le,
  requiredRaces: _restructure["default"].uint32le,
  requiredClasses: _restructure["default"].uint32le,
  excludedRaces: _restructure["default"].uint32le,
  excludedClasses: _restructure["default"].uint32le,
  minRank: _restructure["default"].uint32le,
  parentSpellID: _restructure["default"].uint32le,
  acquireMethod: _restructure["default"].uint32le,
  greyLevel: _restructure["default"].uint32le,
  yellowLevel: _restructure["default"].uint32le,
  charactersPoints: new _restructure["default"].Array(_restructure["default"].uint32le, 2)
});
exports["default"] = _default;