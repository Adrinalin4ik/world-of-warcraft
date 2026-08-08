'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _ffiNapi = require('ffi-napi');

var _ffiNapi2 = _interopRequireDefault(_ffiNapi);

var _refNapi = require('ref-napi');

var _refNapi2 = _interopRequireDefault(_refNapi);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var { bool, uint8, uint32 } = _refNapi2.default.types;
var voidPtr = _refNapi2.default.refType(_refNapi2.default.types.void);

var BLP = voidPtr;
var FILE = voidPtr;

var lib = new _ffiNapi2.default.Library('libblp', {
  blp_convert: [voidPtr, [FILE, BLP, uint8]],
  blp_height: [uint32, [BLP, uint8]],
  blp_nbMipLevels: [uint32, [BLP]],
  blp_processFile: [BLP, [FILE]],
  blp_release: [bool, [BLP]],
  blp_version: [uint8, [BLP]],
  blp_width: [uint32, [BLP, uint8]]
});

exports.default = lib;
module.exports = exports['default'];