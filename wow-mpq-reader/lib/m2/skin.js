"use strict";

function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var r = _interopRequireWildcard(require("restructure"));
var _types = require("../types");
var _nofs = _interopRequireDefault(require("./nofs"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function _getRequireWildcardCache(nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || _typeof(obj) !== "object" && typeof obj !== "function") { return { "default": obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj["default"] = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
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
var _default = new r.Struct({
  signature: new r.String(4),
  indices: new _nofs["default"](r.uint16le),
  triangles: new _nofs["default"](r.uint16le),
  boneIndices: new _nofs["default"](new r.Array(r.uint8, 4)),
  submeshes: new _nofs["default"](Submesh),
  batches: new _nofs["default"](Batch),
  boneCount: r.uint32le
});
exports["default"] = _default;
//# sourceMappingURL=skin.js.map