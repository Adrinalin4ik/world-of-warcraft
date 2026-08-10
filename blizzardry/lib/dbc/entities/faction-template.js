"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  factionID: _restructure["default"].uint32le,
  unknown: new _restructure["default"].Reserved(_restructure["default"].uint32le),
  groupMask: _restructure["default"].uint32le,
  friendlyMask: _restructure["default"].uint32le,
  hostileMask: _restructure["default"].uint32le,
  relatedFactionIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 8)
});
exports["default"] = _default;