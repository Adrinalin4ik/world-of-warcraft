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
  charges: _restructure["default"].uint32le,
  displayTypeIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 3),
  minAmounts: new _restructure["default"].Array(_restructure["default"].uint32le, 3),
  maxAmounts: new _restructure["default"].Array(_restructure["default"].uint32le, 3),
  objectIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 3),
  name: _localizedStringRef["default"],
  itemVisualID: _restructure["default"].uint32le,
  flags: _restructure["default"].uint32le,
  unknown: new _restructure["default"].Reserved(_restructure["default"].uint32le),
  conditionID: _restructure["default"].uint32le,
  skillLineID: _restructure["default"].uint32le,
  skillLevel: _restructure["default"].uint32le,
  requiredLevel: _restructure["default"].uint32le
});
exports["default"] = _default;