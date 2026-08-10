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
  raceID: _restructure["default"].uint32le,
  gender: _restructure["default"].uint32le,
  generalType: _restructure["default"].uint32le,
  textures: new _restructure["default"].Array(_stringRef["default"], 3),
  flags: _restructure["default"].uint32le,
  type: _restructure["default"].uint32le,
  variation: _restructure["default"].uint32le
});
exports["default"] = _default;