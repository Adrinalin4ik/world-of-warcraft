"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _types = require("../../types");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  transportID: _restructure["default"].uint32le,
  timeIndex: _restructure["default"].uint32le,
  position: _types.Vec3Float,
  sequenceID: _restructure["default"].uint32le
});
exports["default"] = _default;