"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = _default;
var _restructure = _interopRequireDefault(require("restructure"));
var _ = _interopRequireDefault(require("./"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _default(fields) {
  var entity = new _restructure["default"].Struct(fields);
  entity.dbc = _["default"]["for"](entity);
  return entity;
}