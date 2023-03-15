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
  mapID: _restructure["default"].uint32le,
  position: _types.Vec3Float,
  fallOffStart: _restructure["default"].floatle,
  fallOffEnd: _restructure["default"].floatle,
  skyFogID: _restructure["default"].uint32le,
  waterID: _restructure["default"].uint32le,
  sunsetID: _restructure["default"].uint32le,
  otherID: _restructure["default"].uint32le,
  deathID: _restructure["default"].uint32le,
  unknowns: new _restructure["default"].Reserved(_restructure["default"].uint32le, 3)
});
exports["default"] = _default;