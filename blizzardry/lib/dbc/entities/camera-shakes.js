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
  type: _restructure["default"].uint32le,
  direction: _restructure["default"].uint32le,
  amplitude: _restructure["default"].floatle,
  frequency: _restructure["default"].floatle,
  duration: _restructure["default"].floatle,
  phase: _restructure["default"].floatle,
  coefficient: _restructure["default"].floatle
});
exports["default"] = _default;