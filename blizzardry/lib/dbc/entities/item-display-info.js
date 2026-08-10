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
  leftModelFile: _stringRef["default"],
  rightModelFile: _stringRef["default"],
  leftModelTexture: _stringRef["default"],
  rightModelTexture: _stringRef["default"],
  icon: _stringRef["default"],
  iconAlt: _stringRef["default"],
  geosetGroupIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 3),
  flags: _restructure["default"].uint32le,
  spellVisualID: _restructure["default"].uint32le,
  groupSoundID: _restructure["default"].uint32le,
  maleHelmetGeosetVisID: _restructure["default"].uint32le,
  femaleHelmetGeosetVisID: _restructure["default"].uint32le,
  upperArmTexture: _stringRef["default"],
  lowerArmTexture: _stringRef["default"],
  handsTexture: _stringRef["default"],
  upperTorsoTexture: _stringRef["default"],
  lowerTorsoTexture: _stringRef["default"],
  upperLegTexture: _stringRef["default"],
  lowerLegTexture: _stringRef["default"],
  footTexture: _stringRef["default"],
  visualID: _restructure["default"].uint32le,
  particleColorID: _restructure["default"].uint32le
});
exports["default"] = _default;