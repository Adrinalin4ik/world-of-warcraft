'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _ffi = require('ffi');

var _ffi2 = _interopRequireDefault(_ffi);

var _ref = require('ref');

var _ref2 = _interopRequireDefault(_ref);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var _ref$types = _ref2.default.types,
    bool = _ref$types.bool,
    uint8 = _ref$types.uint8,
    uint32 = _ref$types.uint32;

var voidPtr = _ref2.default.refType(_ref2.default.types.void);

var BLP = voidPtr;
var FILE = voidPtr;

exports.default = new _ffi2.default.Library('libblp', {
  blp_convert: [voidPtr, [FILE, BLP, uint8]],
  blp_height: [uint32, [BLP, uint8]],
  blp_nbMipLevels: [uint32, [BLP]],
  blp_processFile: [BLP, [FILE]],
  blp_release: [bool, [BLP]],
  blp_version: [uint8, [BLP]],
  blp_width: [uint32, [BLP, uint8]]
});
module.exports = exports['default'];