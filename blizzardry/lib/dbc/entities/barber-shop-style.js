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
  type: _restructure["default"].uint32le,
  name: _localizedStringRef["default"],
  additionalName: _localizedStringRef["default"],
  costModifier: _restructure["default"].floatle,
  raceID: _restructure["default"].uint32le,
  gender: _restructure["default"].uint32le,
  hairID: _restructure["default"].uint32le
});
exports["default"] = _default;