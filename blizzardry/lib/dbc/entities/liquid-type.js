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
  name: _stringRef["default"],
  flags: _restructure["default"].uint32le,
  type: _restructure["default"].uint32le,
  soundEntryID: _restructure["default"].uint32le,
  spellID: _restructure["default"].uint32le,
  maxDarkenDepth: _restructure["default"].floatle,
  fogDarkenIntensity: _restructure["default"].floatle,
  ambDarkenIntensity: _restructure["default"].floatle,
  dirDarkenIntensity: _restructure["default"].floatle,
  lightID: _restructure["default"].uint32le,
  particleScale: _restructure["default"].floatle,
  particleMovement: _restructure["default"].uint32le,
  particleTexSlots: _restructure["default"].uint32le,
  liquidMaterialID: _restructure["default"].uint32le,
  textures: new _restructure["default"].Array(_stringRef["default"], 6),
  colors: new _restructure["default"].Array(_restructure["default"].uint32le, 2),
  shaderFloatAttributes: new _restructure["default"].Array(_restructure["default"].floatle, 18),
  shaderIntAttributes: new _restructure["default"].Array(_restructure["default"].uint32le, 4)
});
exports["default"] = _default;