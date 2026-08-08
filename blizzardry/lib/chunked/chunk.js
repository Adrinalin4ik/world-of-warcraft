"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = _default;
var _restructure = _interopRequireDefault(require("restructure"));
var _xtend = _interopRequireDefault(require("xtend"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _default(fields) {
  var definition = (0, _xtend["default"])({
    id: new _restructure["default"].String(4),
    size: _restructure["default"].uint32le
  }, fields);
  return new _restructure["default"].Struct(definition);
}