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
  entryCount: _restructure["default"].uint32le,
  times: new _restructure["default"].Array(_restructure["default"].uint32le, 16),
  values: new _restructure["default"].Array(_restructure["default"].floatle, 16)
});
exports["default"] = _default;