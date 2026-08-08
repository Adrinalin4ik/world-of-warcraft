"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _ffiNapi = _interopRequireDefault(require("ffi-napi"));
var _refNapi = _interopRequireDefault(require("ref-napi"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _ref$types = _refNapi["default"].types,
  bool = _ref$types.bool,
  uint8 = _ref$types.uint8,
  uint32 = _ref$types.uint32;
var voidPtr = _refNapi["default"].refType(_refNapi["default"].types["void"]);
var BLP = voidPtr;
var FILE = voidPtr;
var lib = new _ffiNapi["default"].Library('libblp', {
  blp_convert: [voidPtr, [FILE, BLP, uint8]],
  blp_height: [uint32, [BLP, uint8]],
  blp_nbMipLevels: [uint32, [BLP]],
  blp_processFile: [BLP, [FILE]],
  blp_release: [bool, [BLP]],
  blp_version: [uint8, [BLP]],
  blp_width: [uint32, [BLP, uint8]]
});
var _default = lib;
exports["default"] = _default;