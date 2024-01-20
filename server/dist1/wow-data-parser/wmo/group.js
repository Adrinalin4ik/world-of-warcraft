'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _chunked = require('../chunked');

var _chunked2 = _interopRequireDefault(_chunked);

var _chunk = require('../chunked/chunk');

var _chunk2 = _interopRequireDefault(_chunk);

var _types = require('../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

var MOGP = (0, _chunk2.default)({
  nameOffset: r.uint32le,
  descriptionOffset: r.uint32le,
  flags: r.uint32le,
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  portalOffset: r.uint16le,
  portalCount: r.uint16le,
  batchCounts: new r.Struct({
    a: r.uint16le,
    b: r.uint16le,
    c: r.int32le
  }),
  fogOffsets: new r.Array(r.uint8, 4),
  unknown: new r.Reserved(r.uint32le),
  groupID: r.uint32le,
  unknowns: new r.Reserved(r.uint32le, 2),

  batchOffsets: function () {
    return {
      a: 0,
      b: this.batchCounts.a,
      c: this.batchCounts.a + this.batchCounts.b
    };
  }
});

var MOPY = (0, _chunk2.default)({
  triangles: new r.Array(new r.Struct({
    flags: r.uint8,
    materialID: r.int8
  }), 'size', 'bytes')
});

var MOVI = (0, _chunk2.default)({
  triangles: new r.Array(r.uint16le, 'size', 'bytes')
});

var MOVT = (0, _chunk2.default)({
  vertices: new r.Array(_types.float32array3, 'size', 'bytes')
});

var MONR = (0, _chunk2.default)({
  normals: new r.Array(_types.float32array3, 'size', 'bytes')
});

var MOTV = (0, _chunk2.default)({
  textureCoords: new r.Array(_types.float32array2, 'size', 'bytes')
});

var MOCV = (0, _chunk2.default)({
  colors: new r.Array(new r.Struct({
    b: r.uint8,
    g: r.uint8,
    r: r.uint8,
    a: r.uint8
  }), 'size', 'bytes')
});

var MOBA = (0, _chunk2.default)({
  batches: new r.Array(new r.Struct({
    skips: new r.Reserved(r.int16le, 2 * 3),
    firstIndex: r.uint32le,
    indexCount: r.uint16le,
    firstVertex: r.uint16le,
    lastVertex: r.uint16le,
    skip: new r.Reserved(r.uint8),
    materialID: r.uint8
  }), 'size', 'bytes')
});

var MODR = (0, _chunk2.default)({
  doodadIndices: new r.Array(r.int16le, 'size', 'bytes')
});

var MOLR = (0, _chunk2.default)({
  lightRefList: new r.Array(r.int16le, 'size', 'bytes')
});

var MOBN = (0, _chunk2.default)({
  nodes: new r.Array(new r.Struct({
    flags: r.uint16le,
    negChild: r.int16le,
    posChild: r.int16le,
    nFaces: r.uint16le,
    faceStart: r.uint32le,
    planeDist: r.floatle
  }), 'size', 'bytes')
});

var MOBR = (0, _chunk2.default)({
  indices: new r.Array(r.int16le, 'size', 'bytes')
});

// const MLIQ = Chunk({
//   xverts: r.uint32le,
//   yverts: r.uint32le,
//   xtiles: r.uint32le,
//   ytiles: r.uint32le,
//   x: Vec3Float,
//   y: Vec3Float,
//   materialId: r.uint32le
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

  MOLR: new r.Optional(MOLR, function () {
    return this.flags & 0x200;
  }),
  MODR: new r.Optional(MODR, function () {
    return this.flags & 0x800;
  }),
  MOBN: new r.Optional(MOBN, function () {
    return this.flags & 0x1;
  }),
  MOBR: new r.Optional(MOBR, function () {
    return this.flags & 0x1;
  }),
  MOCV: new r.Optional(MOCV, function () {
    return this.flags & 0x4;
  }),
  // MLIQ: new r.Optional(MLIQ, function() {
  //   return this.flags & 0x4;
  // }),
  interior: function () {
    return (this.flags & 0x2000) !== 0 && (this.flags & 0x8) === 0;
  }
});
module.exports = exports['default'];