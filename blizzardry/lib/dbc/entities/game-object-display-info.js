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
  file: _stringRef["default"],
  soundIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 10),
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  objectEffectPackageID: _restructure["default"].uint32le
});
exports["default"] = _default;