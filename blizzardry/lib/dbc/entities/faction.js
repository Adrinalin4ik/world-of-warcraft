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
  index: _restructure["default"].int32le,
  raceMask: new _restructure["default"].Array(_restructure["default"].uint32le, 4),
  classMask: new _restructure["default"].Array(_restructure["default"].uint32le, 4),
  reputationBase: new _restructure["default"].Array(_restructure["default"].int32le, 4),
  reputationFlags: new _restructure["default"].Array(_restructure["default"].uint32le, 4),
  parentID: _restructure["default"].uint32le,
  name: _localizedStringRef["default"],
  description: _localizedStringRef["default"]
});
exports["default"] = _default;