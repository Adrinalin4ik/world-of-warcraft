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
  gemColors: new _restructure["default"].Array(_restructure["default"].uint8, 5),
  operands: new _restructure["default"].Array(_restructure["default"].uint32le, 5),
  comparators: new _restructure["default"].Array(_restructure["default"].uint8, 5),
  compareColors: new _restructure["default"].Array(_restructure["default"].uint8, 5),
  values: new _restructure["default"].Array(_restructure["default"].uint32le, 5),
  logicalOperands: new _restructure["default"].Array(_restructure["default"].uint8, 5)
});
exports["default"] = _default;