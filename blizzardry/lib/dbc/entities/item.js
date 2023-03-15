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
  classID: _restructure["default"].uint32le,
  subClassID: _restructure["default"].uint32le,
  soundOverrideSubClassID: _restructure["default"].int32le,
  materialID: _restructure["default"].uint32le,
  displayInfoID: _restructure["default"].uint32le,
  inventorySlotID: _restructure["default"].uint32le,
  sheathID: _restructure["default"].uint32le
});
exports["default"] = _default;