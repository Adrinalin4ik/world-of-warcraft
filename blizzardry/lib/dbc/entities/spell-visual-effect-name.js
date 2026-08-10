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
  name: _stringRef["default"],
  file: _stringRef["default"],
  areaEffectSize: _restructure["default"].floatle,
  scale: _restructure["default"].floatle,
  minScale: _restructure["default"].floatle,
  maxScale: _restructure["default"].floatle
});
exports["default"] = _default;