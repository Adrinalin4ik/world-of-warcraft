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
  thresholds: new _restructure["default"].Array(_restructure["default"].uint32le, 3),
  damageModifiers: new _restructure["default"].Array(_restructure["default"].floatle, 3)
});
exports["default"] = _default;