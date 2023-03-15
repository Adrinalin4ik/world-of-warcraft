"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _stringRef = _interopRequireDefault(require("../string-ref"));
var _types = require("../../types");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  position: _types.Vec3Float,
  direction: _types.Vec3Float,
  soundID: _restructure["default"].uint32le,
  mapID: _restructure["default"].uint32le,
  name: _stringRef["default"]
});
exports["default"] = _default;