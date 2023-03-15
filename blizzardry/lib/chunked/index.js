"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = _default;
var _restructure = _interopRequireDefault(require("restructure"));
var _xtend = _interopRequireDefault(require("xtend"));
var _mver = _interopRequireDefault(require("./mver"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _default(fields) {
  var definition = (0, _xtend["default"])({
    MVER: _mver["default"],
    version: function version() {
      return this.MVER.version;
    }
  }, fields);
  return new _restructure["default"].Struct(definition);
}