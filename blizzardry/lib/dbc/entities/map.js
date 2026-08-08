"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _localizedStringRef = _interopRequireDefault(require("../localized-string-ref"));
var _stringRef = _interopRequireDefault(require("../string-ref"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  internalName: _stringRef["default"],
  type: _restructure["default"].uint32le,
  pvp: new _restructure["default"].Boolean(_restructure["default"].uint32le),
  name: _localizedStringRef["default"],
  areaID: _restructure["default"].uint32le,
  hordeIntro: _localizedStringRef["default"],
  allianceIntro: _localizedStringRef["default"],
  loadingScreenID: _restructure["default"].uint32le,
  minimapIconScale: _restructure["default"].floatle,
  corpseMapID: _restructure["default"].int32le,
  corpseStartX: _restructure["default"].floatle,
  corpseStartY: _restructure["default"].floatle,
  timeOfDayOverride: _restructure["default"].int32le,
  expansionID: _restructure["default"].uint32le,
  maxPlayers: _restructure["default"].uint32le,
  numberOfPlayers: _restructure["default"].uint32le
});
exports["default"] = _default;