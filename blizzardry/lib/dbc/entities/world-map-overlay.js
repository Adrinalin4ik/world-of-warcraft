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
  mapAreaID: _restructure["default"].uint32le,
  areaIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 4),
  mapPointX: _restructure["default"].uint32le,
  mapPointY: _restructure["default"].uint32le,
  textureName: _stringRef["default"],
  textureWidth: _restructure["default"].uint32le,
  textureHeight: _restructure["default"].uint32le,
  offsetX: _restructure["default"].uint32le,
  offsetY: _restructure["default"].uint32le,
  bounds: new _restructure["default"].Struct({
    top: _restructure["default"].uint32le,
    left: _restructure["default"].uint32le,
    bottom: _restructure["default"].uint32le,
    right: _restructure["default"].uint32le
  })
});
exports["default"] = _default;