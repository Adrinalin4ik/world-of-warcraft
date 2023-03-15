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
  emoteTextID: _restructure["default"].uint32le,
  raceID: _restructure["default"].uint32le,
  gender: _restructure["default"].uint32le,
  soundID: _restructure["default"].uint32le
});
exports["default"] = _default;