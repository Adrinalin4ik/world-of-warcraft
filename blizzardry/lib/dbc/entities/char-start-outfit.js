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
  raceID: _restructure["default"].uint8,
  classID: _restructure["default"].uint8,
  gender: _restructure["default"].uint8,
  outfitID: _restructure["default"].uint8,
  itemIDs: new _restructure["default"].Array(_restructure["default"].int32le, 24),
  displayInfoIDs: new _restructure["default"].Array(_restructure["default"].int32le, 24),
  inventoryTypes: new _restructure["default"].Array(_restructure["default"].int32le, 24)
});
exports["default"] = _default;