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
  flags: _restructure["default"].uint32le,
  file: _stringRef["default"],
  sizeClass: _restructure["default"].uint32le,
  scale: _restructure["default"].floatle,
  bloodID: _restructure["default"].int32le,
  skips: new _restructure["default"].Reserved(_restructure["default"].uint32le, 22)
});
exports["default"] = _default;