"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _types = require("../types");
var _animationBlock = _interopRequireDefault(require("./animation-block"));
var _nofs = _interopRequireDefault(require("./nofs"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var Animation = new _restructure["default"].Struct({
  id: _restructure["default"].uint16le,
  subID: _restructure["default"].uint16le,
  length: _restructure["default"].uint32le,
  movementSpeed: _restructure["default"].floatle,
  flags: _restructure["default"].uint32le,
  probability: _restructure["default"].int16le,
  unknowns: new _restructure["default"].Reserved(_restructure["default"].uint16le, 5),
  blendTime: _restructure["default"].uint32le,
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  boundingRadius: _restructure["default"].floatle,
  nextAnimationID: _restructure["default"].int16le,
  alias: _restructure["default"].uint16le
});
var Bone = new _restructure["default"].Struct({
  keyBoneID: _restructure["default"].int32le,
  flags: _restructure["default"].uint32le,
  parentID: _restructure["default"].int16le,
  submeshID: _restructure["default"].int16le,
  unknowns: new _restructure["default"].Reserved(_restructure["default"].uint16le, 2),
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
var Material = new _restructure["default"].Struct({
  renderFlags: _restructure["default"].uint16le,
  blendingMode: _restructure["default"].uint16le
});
var Texture = new _restructure["default"].Struct({
  type: _restructure["default"].uint32le,
  flags: _restructure["default"].uint32le,
  length: _restructure["default"].uint32le,
  filename: new _restructure["default"].Pointer(_restructure["default"].uint32le, new _restructure["default"].String(null), {
    type: 'global'
  })
});
var Vertex = new _restructure["default"].Struct({
  position: _types.float32array3,
  boneWeights: new _restructure["default"].Array(_restructure["default"].uint8, 4),
  boneIndices: new _restructure["default"].Array(_restructure["default"].uint8, 4),
  normal: _types.float32array3,
  textureCoords: new _restructure["default"].Array(_types.float32array2, 2)
});
var Color = new _restructure["default"].Struct({
  color: new _animationBlock["default"](_types.float32array3),
  alpha: new _animationBlock["default"](_types.color16)
});
var UVAnimation = new _restructure["default"].Struct({
  translation: new _animationBlock["default"](_types.float32array3),
  rotation: new _animationBlock["default"](_types.compfixed16array4),
  scaling: new _animationBlock["default"](_types.float32array3),
  animated: function animated() {
    return this.translation.animated || this.rotation.animated || this.scaling.animated;
  }
});
var _default = new _restructure["default"].Struct({
  signature: new _restructure["default"].String(4),
  version: _restructure["default"].uint32le,
  names: new _nofs["default"](new _restructure["default"].String()),
  name: function name() {
    return this.names[0];
  },
  flags: _restructure["default"].uint32le,
  sequences: new _nofs["default"](_restructure["default"].uint32le),
  animations: new _nofs["default"](Animation),
  animationLookups: new _nofs["default"](),
  bones: new _nofs["default"](Bone),
  keyBoneLookups: new _nofs["default"](_restructure["default"].int16le),
  vertices: new _nofs["default"](Vertex),
  viewCount: _restructure["default"].uint32le,
  vertexColorAnimations: new _nofs["default"](Color),
  textures: new _nofs["default"](Texture),
  transparencyAnimations: new _nofs["default"](new _animationBlock["default"](_types.color16)),
  uvAnimations: new _nofs["default"](UVAnimation),
  replacableTextures: new _nofs["default"](),
  materials: new _nofs["default"](Material),
  boneLookups: new _nofs["default"](_restructure["default"].int16le),
  textureLookups: new _nofs["default"](_restructure["default"].int16le),
  textureMappings: new _nofs["default"](_restructure["default"].int16le),
  transparencyAnimationLookups: new _nofs["default"](_restructure["default"].int16le),
  uvAnimationLookups: new _nofs["default"](_restructure["default"].int16le),
  minVertexBox: _types.Vec3Float,
  maxVertexBox: _types.Vec3Float,
  vertexRadius: _restructure["default"].floatle,
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  boundingRadius: _restructure["default"].floatle,
  boundingTriangles: new _nofs["default"](_restructure["default"].uint16le),
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
  blendingOverrides: new _restructure["default"].Optional(new _nofs["default"](_restructure["default"].uint16le), function () {
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