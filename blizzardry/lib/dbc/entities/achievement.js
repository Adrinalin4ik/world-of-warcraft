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
  faction: _restructure["default"].int32le,
  mapID: _restructure["default"].int32le,
  previousID: _restructure["default"].uint32le,
  name: _localizedStringRef["default"],
  description: _localizedStringRef["default"],
  categoryID: _restructure["default"].uint32le,
  points: _restructure["default"].uint32le,
  order: _restructure["default"].uint32le,
  flags: _restructure["default"].uint32le,
  spellIconID: _restructure["default"].uint32le,
  reward: _localizedStringRef["default"],
  minimumCriteria: _restructure["default"].uint32le,
  criteriaTreeID: _restructure["default"].uint32le
});
exports["default"] = _default;