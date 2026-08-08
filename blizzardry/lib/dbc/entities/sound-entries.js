"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _stringRef = _interopRequireDefault(require("../string-ref"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  type: _restructure["default"].uint32le,
  name: _stringRef["default"],
  filenames: new _restructure["default"].Array(_stringRef["default"], 10),
  unknowns: new _restructure["default"].Reserved(_stringRef["default"], 10),
  path: _stringRef["default"],
  volume: _restructure["default"].floatle,
  flags: _restructure["default"].uint32le,
  minDistance: _restructure["default"].floatle,
  distanceCutOff: _restructure["default"].floatle,
  eaxDef: _restructure["default"].uint32le,
  advancedID: _restructure["default"].uint32le
});
exports["default"] = _default;