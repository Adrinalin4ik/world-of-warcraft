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
  rootID: _restructure["default"].uint32le,
  nameSetID: _restructure["default"].uint32le,
  groupID: _restructure["default"].int32le,
  unknowns: new _restructure["default"].Reserved(_restructure["default"].uint32le, 5),
  flags: _restructure["default"].uint32le,
  areaID: _restructure["default"].uint32le,
  name: _localizedStringRef["default"]
});
exports["default"] = _default;