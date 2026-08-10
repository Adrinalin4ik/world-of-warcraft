"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _localizedStringRef = _interopRequireDefault(require("../localized-string-ref"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  mapID: _restructure["default"].uint32le,
  parentID: _restructure["default"].uint32le,
  areaBit: _restructure["default"].uint32le,
  flags: _restructure["default"].uint32le,
  soundPreferenceID: _restructure["default"].uint32le,
  underwaterSoundPreferenceID: _restructure["default"].uint32le,
  soundAmbienceID: _restructure["default"].uint32le,
  zoneMusicID: _restructure["default"].uint32le,
  zoneIntroMusicID: _restructure["default"].uint32le,
  level: _restructure["default"].uint32le,
  name: _localizedStringRef["default"],
  factionGroupID: _restructure["default"].uint32le,
  liquidTypes: new _restructure["default"].Array(_restructure["default"].uint32le, 4),
  minElevation: _restructure["default"].floatle,
  ambientMultiplier: _restructure["default"].floatle,
  lightID: _restructure["default"].uint32le
});
exports["default"] = _default;