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
  minRangeHostile: _restructure["default"].floatle,
  minRangeFriendly: _restructure["default"].floatle,
  maxRangeHostile: _restructure["default"].floatle,
  maxRangeFriendly: _restructure["default"].floatle,
  type: _restructure["default"].uint32le,
  description: _localizedStringRef["default"],
  name: _localizedStringRef["default"]
});
exports["default"] = _default;