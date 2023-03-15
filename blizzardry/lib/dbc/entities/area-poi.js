"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _localizedStringRef = _interopRequireDefault(require("../localized-string-ref"));
var _types = require("../../types");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var Icon = new _restructure["default"].Struct({
  regular: _restructure["default"].uint32le,
  damaged: _restructure["default"].uint32le,
  destroyed: _restructure["default"].uint32le
});
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  importance: _restructure["default"].uint32le,
  neutralIcon: Icon,
  allianceIcon: Icon,
  hordeIcon: Icon,
  factionID: _restructure["default"].uint32le,
  position: _types.Vec3Float,
  mapID: _restructure["default"].uint32le,
  flags: _restructure["default"].uint32le,
  areaID: _restructure["default"].uint32le,
  name: _localizedStringRef["default"],
  description: _localizedStringRef["default"],
  worldStateID: _restructure["default"].uint32le,
  worldMapLink: _restructure["default"].uint32le
});
exports["default"] = _default;