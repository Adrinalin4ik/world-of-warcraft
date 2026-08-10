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
  parentKitID: _restructure["default"].uint32le,
  effectID: _restructure["default"].uint32le,
  attachmentID: _restructure["default"].uint32le,
  offset: _types.Vec3Float,
  yaw: _restructure["default"].floatle,
  pitch: _restructure["default"].floatle,
  roll: _restructure["default"].floatle
});
exports["default"] = _default;