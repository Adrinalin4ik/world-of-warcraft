'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _types = require('../types');

var _chunk = require('./chunk');

var _chunk2 = _interopRequireDefault(_chunk);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.default = (0, _chunk2.default)({
  entries: new r.Array(new r.Struct({
    index: r.uint32le,
    id: r.uint32le,
    position: _types.Vec3Float,
    rotation: _types.Vec3Float,
    minBoundingBox: _types.Vec3Float,
    maxBoundingBox: _types.Vec3Float,
    flags: r.uint16le,
    doodadSet: r.uint16le,
    nameSet: r.uint16le,
    padding: new r.Reserved(r.uint16le),

    filename: function () {
      return this.parent.parent.MWMO.filenames[this.index];
    }
  }), 'size', 'bytes')
});
module.exports = exports['default'];