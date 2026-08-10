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
  greetingSoundID: _restructure["default"].int32le,
  farewellSoundID: _restructure["default"].int32le,
  pissedSoundID: _restructure["default"].int32le,
  unknown: new _restructure["default"].Reserved(_restructure["default"].int32le)
});
exports["default"] = _default;