"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = new _restructure["default"].Pointer(_restructure["default"].uint32le, new _restructure["default"].String(null, 'utf8'), {
  type: 'global',
  relativeTo: function relativeTo() {
    return 'parent.stringBlockOffset';
  }
});
exports["default"] = _default;