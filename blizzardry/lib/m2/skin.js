'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _nofs = require('./nofs');

var _nofs2 = _interopRequireDefault(_nofs);

var _types = require('../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var Submesh = new _restructure2.default.Struct({
  partID: _restructure2.default.uint16le,
  level: _restructure2.default.uint16le,
  startVertex: _restructure2.default.uint16le,
  vertexCount: _restructure2.default.uint16le,
  startTriangle: _restructure2.default.uint16le,
  triangleCount: _restructure2.default.uint16le,
  boneCount: _restructure2.default.uint16le,
  startBone: _restructure2.default.uint16le,
  boneInfluences: _restructure2.default.uint16le,
  rootBone: _restructure2.default.uint16le,
  centerMass: _types.Vec3Float,
  centerBoundingBox: _types.Vec3Float,
  radius: _restructure2.default.floatle
});

var Batch = new _restructure2.default.Struct({
  flags: _restructure2.default.uint16le,
  shaderID: _restructure2.default.uint16le,
  submeshIndex: _restructure2.default.uint16le,
  submeshIndex2: _restructure2.default.uint16le,
  vertexColorAnimationIndex: _restructure2.default.int16le,
  materialIndex: _restructure2.default.uint16le,
  layer: _restructure2.default.uint16le,
  opCount: _restructure2.default.uint16le,
  textureLookup: _restructure2.default.uint16le,
  textureMappingIndex: _restructure2.default.uint16le,
  transparencyAnimationLookup: _restructure2.default.uint16le,
  uvAnimationLookup: _restructure2.default.uint16le
});

exports.default = new _restructure2.default.Struct({
  signature: new _restructure2.default.String(4),
  indices: new _nofs2.default(_restructure2.default.uint16le),
  triangles: new _nofs2.default(_restructure2.default.uint16le),
  boneIndices: new _nofs2.default(new _restructure2.default.Array(_restructure2.default.uint8, 4)),
  submeshes: new _nofs2.default(Submesh),
  batches: new _nofs2.default(Batch),
  boneCount: _restructure2.default.uint32le
});
module.exports = exports['default'];