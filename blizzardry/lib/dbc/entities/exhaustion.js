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
  xp: _restructure["default"].uint32le,
  factor: _restructure["default"].floatle,
  outdoorHours: _restructure["default"].floatle,
  innHours: _restructure["default"].floatle,
  name: _localizedStringRef["default"],
  threshold: _restructure["default"].floatle
});
exports["default"] = _default;