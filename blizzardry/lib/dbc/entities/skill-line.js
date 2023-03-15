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
  categoryID: _restructure["default"].uint32le,
  unknown: new _restructure["default"].Reserved(_restructure["default"].uint32le),
  name: _localizedStringRef["default"],
  description: _localizedStringRef["default"],
  spellIconID: _restructure["default"].uint32le,
  verb: _localizedStringRef["default"],
  canLink: new _restructure["default"].Boolean(_restructure["default"].uint32le)
});
exports["default"] = _default;