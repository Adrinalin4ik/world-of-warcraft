"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _compFixed = _interopRequireDefault(require("./comp-fixed16"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = new _restructure["default"].Array(_compFixed["default"], 4);
exports["default"] = _default;