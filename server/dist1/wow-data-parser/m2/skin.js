'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _types = require('../types');

var _nofs = require('./nofs');

var _nofs2 = _interopRequireDefault(_nofs);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

var Submesh = new r.Struct({
  partID: r.uint16le,
  level: r.uint16le,
  startVertex: r.uint16le,
  vertexCount: r.uint16le,
  startTriangle: r.uint16le,
  triangleCount: r.uint16le,
  boneCount: r.uint16le,
  startBone: r.uint16le,
  boneInfluences: r.uint16le,
  rootBone: r.uint16le,
  centerMass: _types.Vec3Float,
  centerBoundingBox: _types.Vec3Float,
  radius: r.floatle
});

var Batch = new r.Struct({
  flags: r.uint16le,
  shaderID: r.uint16le,
  submeshIndex: r.uint16le,
  submeshIndex2: r.uint16le,
  vertexColorAnimationIndex: r.int16le,
  materialIndex: r.uint16le,
  layer: r.uint16le,
  opCount: r.uint16le,
  textureLookup: r.uint16le,
  textureMappingIndex: r.uint16le,
  transparencyAnimationLookup: r.uint16le,
  uvAnimationLookup: r.uint16le
});

exports.default = new r.Struct({
  signature: new r.String(4),
  indices: new _nofs2.default(r.uint16le),
  triangles: new _nofs2.default(r.uint16le),
  boneIndices: new _nofs2.default(new r.Array(r.uint8, 4)),
  submeshes: new _nofs2.default(Submesh),
  batches: new _nofs2.default(Batch),
  boneCount: r.uint32le
});
module.exports = exports['default'];