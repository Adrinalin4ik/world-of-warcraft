'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _chunk = require('./chunk');

var _chunk2 = _interopRequireDefault(_chunk);

var _types = require('../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _chunk2.default)({
  entries: new _restructure2.default.Array(new _restructure2.default.Struct({
    index: _restructure2.default.uint32le,
    id: _restructure2.default.uint32le,
    position: _types.Vec3Float,
    rotation: _types.Vec3Float,
    minBoundingBox: _types.Vec3Float,
    maxBoundingBox: _types.Vec3Float,
    flags: _restructure2.default.uint16le,
    doodadSet: _restructure2.default.uint16le,
    nameSet: _restructure2.default.uint16le,
    padding: new _restructure2.default.Reserved(_restructure2.default.uint16le),

    filename: function () {
      return this.parent.parent.MWMO.filenames[this.index];
    }
  }), 'size', 'bytes')
});
module.exports = exports['default'];