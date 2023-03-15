"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _ffiNapi = _interopRequireDefault(require("ffi-napi"));
var _refNapi = _interopRequireDefault(require("ref-napi"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var bool = _refNapi["default"].types.bool;
var string = _refNapi["default"].types.CString;
var voidPtr = _refNapi["default"].refType(_refNapi["default"].types["void"]);
var FILE = voidPtr;
var library = process.platform.match(/win32/) ? 'msvcr120' : 'libc';
var lib = new _ffiNapi["default"].Library(library, {
  fopen: [FILE, [string, string]],
  fclose: [bool, [FILE]]
});
var _default = lib;
exports["default"] = _default;
//# sourceMappingURL=c-lib.js.map