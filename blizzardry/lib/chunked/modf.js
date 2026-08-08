"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _chunk = _interopRequireDefault(require("./chunk"));
var _types = require("../types");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _chunk["default"])({
  entries: new _restructure["default"].Array(new _restructure["default"].Struct({
    index: _restructure["default"].uint32le,
    id: _restructure["default"].uint32le,
    position: _types.Vec3Float,
    rotation: _types.Vec3Float,
    minBoundingBox: _types.Vec3Float,
    maxBoundingBox: _types.Vec3Float,
    flags: _restructure["default"].uint16le,
    doodadSet: _restructure["default"].uint16le,
    nameSet: _restructure["default"].uint16le,
    padding: new _restructure["default"].Reserved(_restructure["default"].uint16le),
    filename: function filename() {
      return this.parent.parent.MWMO.filenames[this.index];
    }
  }), 'size', 'bytes')
});
exports["default"] = _default;