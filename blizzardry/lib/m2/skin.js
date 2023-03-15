"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _nofs = _interopRequireDefault(require("./nofs"));
var _types = require("../types");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var Submesh = new _restructure["default"].Struct({
  partID: _restructure["default"].uint16le,
  level: _restructure["default"].uint16le,
  startVertex: _restructure["default"].uint16le,
  vertexCount: _restructure["default"].uint16le,
  startTriangle: _restructure["default"].uint16le,
  triangleCount: _restructure["default"].uint16le,
  boneCount: _restructure["default"].uint16le,
  startBone: _restructure["default"].uint16le,
  boneInfluences: _restructure["default"].uint16le,
  rootBone: _restructure["default"].uint16le,
  centerMass: _types.Vec3Float,
  centerBoundingBox: _types.Vec3Float,
  radius: _restructure["default"].floatle
});
var Batch = new _restructure["default"].Struct({
  flags: _restructure["default"].uint16le,
  shaderID: _restructure["default"].uint16le,
  submeshIndex: _restructure["default"].uint16le,
  submeshIndex2: _restructure["default"].uint16le,
  vertexColorAnimationIndex: _restructure["default"].int16le,
  materialIndex: _restructure["default"].uint16le,
  layer: _restructure["default"].uint16le,
  opCount: _restructure["default"].uint16le,
  textureLookup: _restructure["default"].uint16le,
  textureMappingIndex: _restructure["default"].uint16le,
  transparencyAnimationLookup: _restructure["default"].uint16le,
  uvAnimationLookup: _restructure["default"].uint16le
});
var _default = new _restructure["default"].Struct({
  signature: new _restructure["default"].String(4),
  indices: new _nofs["default"](_restructure["default"].uint16le),
  triangles: new _nofs["default"](_restructure["default"].uint16le),
  boneIndices: new _nofs["default"](new _restructure["default"].Array(_restructure["default"].uint8, 4)),
  submeshes: new _nofs["default"](Submesh),
  batches: new _nofs["default"](Batch),
  boneCount: _restructure["default"].uint32le
});
exports["default"] = _default;