"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _types = require("../../types");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  pathID: _restructure["default"].uint32le,
  nodeIndex: _restructure["default"].uint32le,
  mapID: _restructure["default"].uint32le,
  position: _types.Vec3Float,
  flags: _restructure["default"].uint32le,
  delay: _restructure["default"].uint32le,
  arrivalEventID: _restructure["default"].uint32le,
  departureEventID: _restructure["default"].uint32le
});
exports["default"] = _default;