'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _ffiNapi = require('ffi-napi');

var _ffiNapi2 = _interopRequireDefault(_ffiNapi);

var _refNapi = require('ref-napi');

var _refNapi2 = _interopRequireDefault(_refNapi);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var { bool } = _refNapi2.default.types;
var string = _refNapi2.default.types.CString;

var voidPtr = _refNapi2.default.refType(_refNapi2.default.types.void);

var FILE = voidPtr;

var library = process.platform.match(/win32/) ? 'msvcr120' : 'libc';

var lib = new _ffiNapi2.default.Library(library, {
  fopen: [FILE, [string, string]],
  fclose: [bool, [FILE]]
});

exports.default = lib;
module.exports = exports['default'];