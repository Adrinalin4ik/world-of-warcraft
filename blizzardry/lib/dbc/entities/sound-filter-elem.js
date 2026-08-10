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
  filterID: _restructure["default"].uint32le,
  order: _restructure["default"].uint32le,
  type: _restructure["default"].uint32le,
  parameters: new _restructure["default"].Array(_restructure["default"].floatle, 9)
});
exports["default"] = _default;