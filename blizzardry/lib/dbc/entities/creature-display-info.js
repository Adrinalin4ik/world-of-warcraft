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
  modelID: _restructure["default"].uint32le,
  soundID: _restructure["default"].uint32le,
  extraInfoID: _restructure["default"].uint32le,
  scale: _restructure["default"].floatle,
  opacity: _restructure["default"].uint32le,
  skin1: _stringRef["default"],
  skin2: _stringRef["default"],
  skin3: _stringRef["default"],
  portraitTexture: _stringRef["default"],
  skips: new _restructure["default"].Reserved(_restructure["default"].uint32le, 6)
});
exports["default"] = _default;