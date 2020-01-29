'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _chunk = require('../chunked/chunk');

var _chunk2 = _interopRequireDefault(_chunk);

var _chunked = require('../chunked');

var _chunked2 = _interopRequireDefault(_chunked);

var _skipChunk = require('../chunked/skip-chunk');

var _skipChunk2 = _interopRequireDefault(_skipChunk);

var _types = require('../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var MOGP = (0, _chunk2.default)({
  nameOffset: _restructure2.default.uint32le,
  descriptionOffset: _restructure2.default.uint32le,
  flags: _restructure2.default.uint32le,
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  portalOffset: _restructure2.default.uint16le,
  portalCount: _restructure2.default.uint16le,
  batchCounts: new _restructure2.default.Struct({
    a: _restructure2.default.uint16le,
    b: _restructure2.default.uint16le,
    c: _restructure2.default.int32le
  }),
  fogOffsets: new _restructure2.default.Array(_restructure2.default.uint8, 4),
  unknown: new _restructure2.default.Reserved(_restructure2.default.uint32le),
  groupID: _restructure2.default.uint32le,
  unknowns: new _restructure2.default.Reserved(_restructure2.default.uint32le, 2),

  batchOffsets: function () {
    return {
      a: 0,
      b: this.batchCounts.a,
      c: this.batchCounts.a + this.batchCounts.b
    };
  }
});

var MOPY = (0, _chunk2.default)({
  triangles: new _restructure2.default.Array(new _restructure2.default.Struct({
    flags: _restructure2.default.uint8,
    materialID: _restructure2.default.int8
  }), 'size', 'bytes')
});

var MOVI = (0, _chunk2.default)({
  triangles: new _restructure2.default.Array(_restructure2.default.uint16le, 'size', 'bytes')
});

var MOVT = (0, _chunk2.default)({
  vertices: new _restructure2.default.Array(_types.float32array3, 'size', 'bytes')
});

var MONR = (0, _chunk2.default)({
  normals: new _restructure2.default.Array(_types.float32array3, 'size', 'bytes')
});

var MOTV = (0, _chunk2.default)({
  textureCoords: new _restructure2.default.Array(_types.float32array2, 'size', 'bytes')
});

var MOCV = (0, _chunk2.default)({
  colors: new _restructure2.default.Array(new _restructure2.default.Struct({
    b: _restructure2.default.uint8,
    g: _restructure2.default.uint8,
    r: _restructure2.default.uint8,
    a: _restructure2.default.uint8
  }), 'size', 'bytes')
});

var MOBA = (0, _chunk2.default)({
  batches: new _restructure2.default.Array(new _restructure2.default.Struct({
    skips: new _restructure2.default.Reserved(_restructure2.default.int16le, 2 * 3),
    firstIndex: _restructure2.default.uint32le,
    indexCount: _restructure2.default.uint16le,
    firstVertex: _restructure2.default.uint16le,
    lastVertex: _restructure2.default.uint16le,
    skip: new _restructure2.default.Reserved(_restructure2.default.uint8),
    materialID: _restructure2.default.uint8
  }), 'size', 'bytes')
});

var MODR = (0, _chunk2.default)({
  doodadIndices: new _restructure2.default.Array(_restructure2.default.int16le, 'size', 'bytes')
});

// const MOBN = Chunk({
//   data: new r.Struct({
//     flags: r.uint16le,
//     negChild: r.int16le,
//     posChild: r.int16le,
//     nFaces: r.uint16le,
//     faceStart: r.uint32le,
//     planeDist: r.floatle
//   })
// });

exports.default = (0, _chunked2.default)({
  MOGP: MOGP,
  MOPY: MOPY,
  MOVI: MOVI,
  MOVT: MOVT,
  MONR: MONR,
  MOTV: MOTV,
  MOBA: MOBA,

  flags: function () {
    return this.MOGP.flags;
  },

  MOLR: new _restructure2.default.Optional(_skipChunk2.default, function () {
    return this.flags & 0x200;
  }),
  MODR: new _restructure2.default.Optional(MODR, function () {
    return this.flags & 0x800;
  }),
  MOBN: new _restructure2.default.Optional(_skipChunk2.default, function () {
    return this.flags & 0x1;
  }),
  MOBR: new _restructure2.default.Optional(_skipChunk2.default, function () {
    return this.flags & 0x1;
  }),
  MOCV: new _restructure2.default.Optional(MOCV, function () {
    return this.flags & 0x4;
  }),

  interior: function () {
    return (this.flags & 0x2000) !== 0 && (this.flags & 0x8) === 0;
  }
});
module.exports = exports['default'];