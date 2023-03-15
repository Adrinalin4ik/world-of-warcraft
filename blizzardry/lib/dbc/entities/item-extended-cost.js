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
  costHonor: _restructure["default"].uint32le,
  costArena: _restructure["default"].uint32le,
  itemIDs: new _restructure["default"].Array(_restructure["default"].uint32le, 5),
  itemCounts: new _restructure["default"].Array(_restructure["default"].uint32le, 5),
  personalRating: _restructure["default"].uint32le,
  purchaseGroupID: _restructure["default"].uint32le,
  unknown: new _restructure["default"].Reserved(_restructure["default"].uint32le)
});
exports["default"] = _default;