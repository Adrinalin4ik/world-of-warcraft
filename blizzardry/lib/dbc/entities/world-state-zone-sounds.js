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
  value: _restructure["default"].uint32le,
  areaID: _restructure["default"].uint32le,
  wmoAreaID: _restructure["default"].uint32le,
  introMusicID: _restructure["default"].uint32le,
  musicID: _restructure["default"].uint32le,
  soundAmbienceID: _restructure["default"].uint32le,
  soundProviderPreferenceID: _restructure["default"].uint32le
});
exports["default"] = _default;