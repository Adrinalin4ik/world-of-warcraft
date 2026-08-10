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
  flags: _restructure["default"].uint32le,
  factionID: _restructure["default"].uint32le,
  explorationSoundID: _restructure["default"].uint32le,
  maleDisplayID: _restructure["default"].uint32le,
  femaleDisplayID: _restructure["default"].uint32le,
  clientPrefix: _stringRef["default"],
  skip: new _restructure["default"].Reserved(_restructure["default"].uint32le),
  baseLanguage: _restructure["default"].uint32le,
  resSicknessSpellID: _restructure["default"].uint32le,
  splashSoundID: _restructure["default"].uint32le,
  clientFileString: _stringRef["default"],
  cinematicSequenceID: _restructure["default"].uint32le,
  name: _localizedStringRef["default"],
  nameFemale: _localizedStringRef["default"],
  nameMale: _localizedStringRef["default"],
  facialHairCustomization: _stringRef["default"],
  facialHairCustomization2: _stringRef["default"],
  hairCustomization: _stringRef["default"],
  expansionID: _restructure["default"].uint32le
});
exports["default"] = _default;