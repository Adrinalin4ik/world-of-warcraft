'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _ffi = require('ffi');

var _ffi2 = _interopRequireDefault(_ffi);

var _ref = require('ref');

var _ref2 = _interopRequireDefault(_ref);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var bool = _ref2.default.types.bool;

var string = _ref2.default.types.CString;

var voidPtr = _ref2.default.refType(_ref2.default.types.void);

var FILE = voidPtr;

var library = process.platform.match(/win32/) ? 'msvcr120' : 'libc';

exports.default = new _ffi2.default.Library(library, {
  fopen: [FILE, [string, string]],
  fclose: [bool, [FILE]]
});
module.exports = exports['default'];