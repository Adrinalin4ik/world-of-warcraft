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
  mapID: _restructure["default"].uint32le,
  areaID: _restructure["default"].uint32le,
  name: _stringRef["default"],
  position: new _restructure["default"].Struct({
    left: _restructure["default"].floatle,
    right: _restructure["default"].floatle,
    top: _restructure["default"].floatle,
    bottom: _restructure["default"].floatle
  }),
  displayMapID: _restructure["default"].int32le,
  defaultDungeonFloor: _restructure["default"].uint32le,
  unknown: new _restructure["default"].Reserved(_restructure["default"].uint32le)
});
exports["default"] = _default;