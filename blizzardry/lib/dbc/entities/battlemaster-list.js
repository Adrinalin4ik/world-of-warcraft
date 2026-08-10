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
  instanceIDs: new _restructure["default"].Array(_restructure["default"].int32le, 8),
  type: _restructure["default"].uint32le,
  minLevel: _restructure["default"].uint32le,
  maxLevel: _restructure["default"].uint32le,
  teamSize: _restructure["default"].uint32le,
  unknowns: new _restructure["default"].Reserved(_restructure["default"].uint32le, 3),
  name: _localizedStringRef["default"],
  unknowns2: new _restructure["default"].Reserved(_restructure["default"].uint32le, 2)
});
exports["default"] = _default;