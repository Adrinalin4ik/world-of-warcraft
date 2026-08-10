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
  type: _restructure["default"].uint32le,
  rgba: new _restructure["default"].Array(_restructure["default"].uint8, 4),
  edge: _restructure["default"].uint32le,
  bw: _restructure["default"].uint32le,
  unknown: new _restructure["default"].Reserved(_restructure["default"].uint32le),
  lightParamsID: _restructure["default"].int32le,
  soundAmbienceID: _restructure["default"].uint32le,
  zoneMusicID: _restructure["default"].uint32le
});
exports["default"] = _default;