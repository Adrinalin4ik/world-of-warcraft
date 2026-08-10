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
  highlightSky: new _restructure["default"].Boolean(_restructure["default"].uint32le),
  lightSkyboxID: _restructure["default"].uint32le,
  glow: _restructure["default"].floatle,
  waterShallowAlpha: _restructure["default"].floatle,
  waterDeepAlpha: _restructure["default"].floatle,
  oceanShallowAlpha: _restructure["default"].floatle,
  oceanDeepAlpha: _restructure["default"].floatle,
  flags: _restructure["default"].uint32le
});
exports["default"] = _default;