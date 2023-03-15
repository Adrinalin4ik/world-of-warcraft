"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _chunk = _interopRequireDefault(require("./chunk"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _chunk["default"])({
  filenames: new _restructure["default"].Array(new _restructure["default"].String(null), 'size', 'bytes')
});
exports["default"] = _default;