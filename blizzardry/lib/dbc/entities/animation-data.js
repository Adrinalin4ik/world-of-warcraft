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
  weaponFlags: _restructure["default"].uint32le,
  bodyFlags: _restructure["default"].uint32le,
  flags: _restructure["default"].uint32le,
  fallbackID: _restructure["default"].uint32le,
  behaviorID: _restructure["default"].uint32le,
  behaviorTier: _restructure["default"].uint32le
});
exports["default"] = _default;