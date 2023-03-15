"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _chunk = _interopRequireDefault(require("../chunked/chunk"));
var _chunked = _interopRequireDefault(require("../chunked"));
var _skipChunk = _interopRequireDefault(require("../chunked/skip-chunk"));
var _types = require("../types");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var MOGP = (0, _chunk["default"])({
  nameOffset: _restructure["default"].uint32le,
  descriptionOffset: _restructure["default"].uint32le,
  flags: _restructure["default"].uint32le,
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  portalOffset: _restructure["default"].uint16le,
  portalCount: _restructure["default"].uint16le,
  batchCounts: new _restructure["default"].Struct({
    a: _restructure["default"].uint16le,
    b: _restructure["default"].uint16le,
    c: _restructure["default"].int32le
  }),
  fogOffsets: new _restructure["default"].Array(_restructure["default"].uint8, 4),
  unknown: new _restructure["default"].Reserved(_restructure["default"].uint32le),
  groupID: _restructure["default"].uint32le,
  unknowns: new _restructure["default"].Reserved(_restructure["default"].uint32le, 2),
  batchOffsets: function batchOffsets() {
    return {
      a: 0,
      b: this.batchCounts.a,
      c: this.batchCounts.a + this.batchCounts.b
    };
  }
});
var MOPY = (0, _chunk["default"])({
  triangles: new _restructure["default"].Array(new _restructure["default"].Struct({
    flags: _restructure["default"].uint8,
    materialID: _restructure["default"].int8
  }), 'size', 'bytes')
});
var MOVI = (0, _chunk["default"])({
  triangles: new _restructure["default"].Array(_restructure["default"].uint16le, 'size', 'bytes')
});
var MOVT = (0, _chunk["default"])({
  vertices: new _restructure["default"].Array(_types.float32array3, 'size', 'bytes')
});
var MONR = (0, _chunk["default"])({
  normals: new _restructure["default"].Array(_types.float32array3, 'size', 'bytes')
});
var MOTV = (0, _chunk["default"])({
  textureCoords: new _restructure["default"].Array(_types.float32array2, 'size', 'bytes')
});
var MOCV = (0, _chunk["default"])({
  colors: new _restructure["default"].Array(new _restructure["default"].Struct({
    b: _restructure["default"].uint8,
    g: _restructure["default"].uint8,
    r: _restructure["default"].uint8,
    a: _restructure["default"].uint8
  }), 'size', 'bytes')
});
var MOBA = (0, _chunk["default"])({
  batches: new _restructure["default"].Array(new _restructure["default"].Struct({
    skips: new _restructure["default"].Reserved(_restructure["default"].int16le, 2 * 3),
    firstIndex: _restructure["default"].uint32le,
    indexCount: _restructure["default"].uint16le,
    firstVertex: _restructure["default"].uint16le,
    lastVertex: _restructure["default"].uint16le,
    skip: new _restructure["default"].Reserved(_restructure["default"].uint8),
    materialID: _restructure["default"].uint8
  }), 'size', 'bytes')
});
var MODR = (0, _chunk["default"])({
  doodadIndices: new _restructure["default"].Array(_restructure["default"].int16le, 'size', 'bytes')
});
var MOLR = (0, _chunk["default"])({
  lightRefList: new _restructure["default"].Array(_restructure["default"].int16le, 'size', 'bytes')
});
var MOBN = (0, _chunk["default"])({
  nodes: new _restructure["default"].Array(new _restructure["default"].Struct({
    flags: _restructure["default"].uint16le,
    negChild: _restructure["default"].int16le,
    posChild: _restructure["default"].int16le,
    nFaces: _restructure["default"].uint16le,
    faceStart: _restructure["default"].uint32le,
    planeDist: _restructure["default"].floatle
  }), 'size', 'bytes')
});
var MOBR = (0, _chunk["default"])({
  indices: new _restructure["default"].Array(_restructure["default"].int16le, 'size', 'bytes')
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
var _default = (0, _chunked["default"])({
  MOGP: MOGP,
  MOPY: MOPY,
  MOVI: MOVI,
  MOVT: MOVT,
  MONR: MONR,
  MOTV: MOTV,
  MOBA: MOBA,
  flags: function flags() {
    return this.MOGP.flags;
  },
  MOLR: new _restructure["default"].Optional(MOLR, function () {
    return this.flags & 0x200;
  }),
  MODR: new _restructure["default"].Optional(MODR, function () {
    return this.flags & 0x800;
  }),
  MOBN: new _restructure["default"].Optional(MOBN, function () {
    return this.flags & 0x1;
  }),
  MOBR: new _restructure["default"].Optional(MOBR, function () {
    return this.flags & 0x1;
  }),
  MOCV: new _restructure["default"].Optional(MOCV, function () {
    return this.flags & 0x4;
  }),
  // MLIQ: new r.Optional(MLIQ, function() {
  //   return this.flags & 0x4;
  // }),
  interior: function interior() {
    return (this.flags & 0x2000) !== 0 && (this.flags & 0x8) === 0;
  }
});
exports["default"] = _default;