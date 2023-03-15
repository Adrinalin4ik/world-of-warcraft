"use strict";

function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var r = _interopRequireWildcard(require("restructure"));
var _types = require("../types");
var _animationBlock = _interopRequireDefault(require("./animation-block"));
var _nofs = _interopRequireDefault(require("./nofs"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function _getRequireWildcardCache(nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || _typeof(obj) !== "object" && typeof obj !== "function") { return { "default": obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj["default"] = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
var Animation = new r.Struct({
  id: r.uint16le,
  subID: r.uint16le,
  length: r.uint32le,
  movementSpeed: r.floatle,
  flags: r.uint32le,
  probability: r.int16le,
  unknowns: new r.Reserved(r.uint16le, 5),
  blendTime: r.uint32le,
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  boundingRadius: r.floatle,
  nextAnimationID: r.int16le,
  alias: r.uint16le
});
var Bone = new r.Struct({
  keyBoneID: r.int32le,
  flags: r.uint32le,
  parentID: r.int16le,
  submeshID: r.int16le,
  unknowns: new r.Reserved(r.uint16le, 2),
  translation: new _animationBlock["default"](_types.float32array3),
  rotation: new _animationBlock["default"](_types.compfixed16array4),
  scaling: new _animationBlock["default"](_types.float32array3),
  pivotPoint: _types.float32array3,
  billboardType: function billboardType() {
    // Spherical
    if (this.flags & 0x08) {
      return 0;
      // Cylindrical; locked to x
    } else if (this.flags & 0x10) {
      return 1;
      // Cylindrical; locked to y
    } else if (this.flags & 0x20) {
      return 2;
      // Cylindrical; locked to z
    } else if (this.flags & 0x40) {
      return 3;
    } else {
      return null;
    }
  },
  billboarded: function billboarded() {
    return this.billboardType !== null;
  },
  animated: function animated() {
    return this.translation.animated || this.rotation.animated || this.scaling.animated || this.billboarded;
  }
});
var Material = new r.Struct({
  renderFlags: r.uint16le,
  blendingMode: r.uint16le
});
var Texture = new r.Struct({
  type: r.uint32le,
  flags: r.uint32le,
  length: r.uint32le,
  filename: new r.Pointer(r.uint32le, new r.String(null), {
    type: 'global'
  })
});
var Vertex = new r.Struct({
  position: _types.float32array3,
  boneWeights: new r.Array(r.uint8, 4),
  boneIndices: new r.Array(r.uint8, 4),
  normal: _types.float32array3,
  textureCoords: new r.Array(_types.float32array2, 2)
});
var Color = new r.Struct({
  color: new _animationBlock["default"](_types.float32array3),
  alpha: new _animationBlock["default"](_types.color16)
});
var UVAnimation = new r.Struct({
  translation: new _animationBlock["default"](_types.float32array3),
  rotation: new _animationBlock["default"](_types.compfixed16array4),
  scaling: new _animationBlock["default"](_types.float32array3),
  animated: function animated() {
    return this.translation.animated || this.rotation.animated || this.scaling.animated;
  }
});
var _default = new r.Struct({
  signature: new r.String(4),
  version: r.uint32le,
  names: new _nofs["default"](new r.String()),
  name: function name() {
    return this.names[0];
  },
  flags: r.uint32le,
  sequences: new _nofs["default"](r.uint32le),
  animations: new _nofs["default"](Animation),
  animationLookups: new _nofs["default"](),
  bones: new _nofs["default"](Bone),
  keyBoneLookups: new _nofs["default"](r.int16le),
  vertices: new _nofs["default"](Vertex),
  viewCount: r.uint32le,
  vertexColorAnimations: new _nofs["default"](Color),
  textures: new _nofs["default"](Texture),
  transparencyAnimations: new _nofs["default"](new _animationBlock["default"](_types.color16)),
  uvAnimations: new _nofs["default"](UVAnimation),
  replacableTextures: new _nofs["default"](),
  materials: new _nofs["default"](Material),
  boneLookups: new _nofs["default"](r.int16le),
  textureLookups: new _nofs["default"](r.int16le),
  textureMappings: new _nofs["default"](r.int16le),
  transparencyAnimationLookups: new _nofs["default"](r.int16le),
  uvAnimationLookups: new _nofs["default"](r.int16le),
  minVertexBox: _types.Vec3Float,
  maxVertexBox: _types.Vec3Float,
  vertexRadius: r.floatle,
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  boundingRadius: r.floatle,
  boundingTriangles: new _nofs["default"](r.uint16le),
  boundingVertices: new _nofs["default"](_types.Vec3Float),
  boundingNormals: new _nofs["default"](_types.Vec3Float),
  attachments: new _nofs["default"](),
  attachmentLookups: new _nofs["default"](),
  events: new _nofs["default"](),
  lights: new _nofs["default"](),
  cameras: new _nofs["default"](),
  cameraLookups: new _nofs["default"](),
  ribbonEmitters: new _nofs["default"](),
  particleEmitters: new _nofs["default"](),
  blendingOverrides: new r.Optional(new _nofs["default"](r.uint16le), function () {
    return (this.flags & 0x08) !== 0;
  }),
  overrideBlending: function overrideBlending() {
    return (this.flags & 0x08) !== 0;
  },
  canInstance: function canInstance() {
    var instance = true;
    this.bones.forEach(function (bone) {
      if (bone.animated) {
        instance = false;
      }
    });
    return instance;
  },
  animated: function animated() {
    var animated = false;
    this.bones.forEach(function (bone) {
      if (bone.animated) {
        animated = true;
      }
    });
    this.uvAnimations.forEach(function (uvAnimation) {
      if (uvAnimation.animated) {
        animated = true;
      }
    });
    this.transparencyAnimations.forEach(function (transparency) {
      if (transparency.animated) {
        if (transparency.keyframeCount > 1) {
          animated = true;
        } else if (transparency.firstKeyframe.value !== 1.0) {
          animated = true;
        }
      }
    });
    this.vertexColorAnimations.forEach(function (color) {
      if (color.color.animated || color.alpha.animated) {
        animated = true;
      }
    });
    return animated;
  }
});
exports["default"] = _default;
//# sourceMappingURL=index.js.map