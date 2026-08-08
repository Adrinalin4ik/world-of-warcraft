"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _localizedStringRef = _interopRequireDefault(require("../localized-string-ref"));
var _stringRef = _interopRequireDefault(require("../string-ref"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  mapID: _restructure["default"].int32le,
  zoneID: _restructure["default"].uint32le,
  phase: _restructure["default"].uint32le,
  text: _localizedStringRef["default"],
  description: _localizedStringRef["default"],
  state: _restructure["default"].int32le,
  worldState: _restructure["default"].uint32le,
  type: _restructure["default"].uint32le,
  icon: _stringRef["default"],
  tooltip: _localizedStringRef["default"],
  ui: _stringRef["default"],
  stateVariables: new _restructure["default"].Array(_restructure["default"].uint32le, 3)
});
exports["default"] = _default;