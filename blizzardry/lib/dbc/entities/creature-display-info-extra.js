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
  raceID: _restructure["default"].uint32le,
  gender: _restructure["default"].uint32le,
  skinColor: _restructure["default"].uint32le,
  faceType: _restructure["default"].uint32le,
  hairType: _restructure["default"].uint32le,
  hairStyle: _restructure["default"].uint32le,
  beardStyle: _restructure["default"].uint32le,
  helmID: _restructure["default"].uint32le,
  shoulderID: _restructure["default"].uint32le,
  shirtID: _restructure["default"].uint32le,
  cuirassID: _restructure["default"].uint32le,
  beltID: _restructure["default"].uint32le,
  legsID: _restructure["default"].uint32le,
  bootsID: _restructure["default"].uint32le,
  wristID: _restructure["default"].uint32le,
  glovesID: _restructure["default"].uint32le,
  tabardID: _restructure["default"].uint32le,
  capeID: _restructure["default"].uint32le,
  canEquip: new _restructure["default"].Boolean(_restructure["default"].uint32le),
  texture: _stringRef["default"]
});
exports["default"] = _default;