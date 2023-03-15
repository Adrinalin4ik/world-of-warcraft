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
  minScale: _restructure["default"].floatle,
  minScaleLevel: _restructure["default"].uint32le,
  maxScale: _restructure["default"].floatle,
  maxScaleLevel: _restructure["default"].uint32le,
  skillIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 2),
  petFoodMask: _restructure["default"].uint32le,
  petTalentType: _restructure["default"].int32le,
  categoryEnumID: _restructure["default"].int32le,
  name: _localizedStringRef["default"],
  iconFile: _stringRef["default"]
});
exports["default"] = _default;