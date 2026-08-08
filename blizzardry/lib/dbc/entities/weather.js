"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _stringRef = _interopRequireDefault(require("../string-ref"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  ambienceID: _restructure["default"].uint32le,
  effectType: _restructure["default"].uint32le,
  effectColors: new _restructure["default"].Array(_restructure["default"].floatle, 3),
  effectTexture: _stringRef["default"]
});
exports["default"] = _default;