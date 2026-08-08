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
  silenceIntervalMinDay: _restructure["default"].uint32le,
  silenceIntervalMinNight: _restructure["default"].uint32le,
  silenceIntervalMaxDay: _restructure["default"].uint32le,
  silenceIntervalMaxNight: _restructure["default"].uint32le,
  dayMusicID: _restructure["default"].uint32le,
  nightMusicID: _restructure["default"].uint32le
});
exports["default"] = _default;