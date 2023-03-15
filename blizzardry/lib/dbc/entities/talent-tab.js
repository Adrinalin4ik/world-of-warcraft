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
  name: _localizedStringRef["default"],
  spellIconID: _restructure["default"].uint32le,
  raceMask: _restructure["default"].uint32le,
  classMask: _restructure["default"].uint32le,
  creatureFamilyMask: _restructure["default"].uint32le,
  order: _restructure["default"].uint32le,
  backgroundFile: _stringRef["default"]
});
exports["default"] = _default;