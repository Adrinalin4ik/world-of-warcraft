'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _animationBlock = require('./animation-block');

var _animationBlock2 = _interopRequireDefault(_animationBlock);

var _nofs = require('./nofs');

var _nofs2 = _interopRequireDefault(_nofs);

var _types = require('../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var Animation = new _restructure2.default.Struct({
  id: _restructure2.default.uint16le,
  subID: _restructure2.default.uint16le,
  length: _restructure2.default.uint32le,
  movementSpeed: _restructure2.default.floatle,
  flags: _restructure2.default.uint32le,
  probability: _restructure2.default.int16le,

  unknowns: new _restructure2.default.Reserved(_restructure2.default.uint16le, 5),

  blendTime: _restructure2.default.uint32le,
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  boundingRadius: _restructure2.default.floatle,
  nextAnimationID: _restructure2.default.int16le,
  alias: _restructure2.default.uint16le
});

var Bone = new _restructure2.default.Struct({
  keyBoneID: _restructure2.default.int32le,
  flags: _restructure2.default.uint32le,
  parentID: _restructure2.default.int16le,
  submeshID: _restructure2.default.int16le,

  unknowns: new _restructure2.default.Reserved(_restructure2.default.uint16le, 2),

  translation: new _animationBlock2.default(_types.float32array3),
  rotation: new _animationBlock2.default(_types.compfixed16array4),
  scaling: new _animationBlock2.default(_types.float32array3),

  pivotPoint: _types.float32array3,

  billboardType: function () {
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

  billboarded: function () {
    return this.billboardType !== null;
  },

  animated: function () {
    return this.translation.animated || this.rotation.animated || this.scaling.animated || this.billboarded;
  }
});

var Material = new _restructure2.default.Struct({
  renderFlags: _restructure2.default.uint16le,
  blendingMode: _restructure2.default.uint16le
});

var Texture = new _restructure2.default.Struct({
  type: _restructure2.default.uint32le,
  flags: _restructure2.default.uint32le,
  length: _restructure2.default.uint32le,
  filename: new _restructure2.default.Pointer(_restructure2.default.uint32le, new _restructure2.default.String(null), 'global')
});

var Vertex = new _restructure2.default.Struct({
  position: _types.float32array3,
  boneWeights: new _restructure2.default.Array(_restructure2.default.uint8, 4),
  boneIndices: new _restructure2.default.Array(_restructure2.default.uint8, 4),
  normal: _types.float32array3,
  textureCoords: new _restructure2.default.Array(_types.float32array2, 2)
});

var Color = new _restructure2.default.Struct({
  color: new _animationBlock2.default(_types.float32array3),
  alpha: new _animationBlock2.default(_types.color16)
});

var UVAnimation = new _restructure2.default.Struct({
  translation: new _animationBlock2.default(_types.float32array3),
  rotation: new _animationBlock2.default(_types.compfixed16array4),
  scaling: new _animationBlock2.default(_types.float32array3),

  animated: function () {
    return this.translation.animated || this.rotation.animated || this.scaling.animated;
  }
});

exports.default = new _restructure2.default.Struct({
  signature: new _restructure2.default.String(4),
  version: _restructure2.default.uint32le,

  names: new _nofs2.default(new _restructure2.default.String()),
  name: function () {
    return this.names[0];
  },

  flags: _restructure2.default.uint32le,

  sequences: new _nofs2.default(_restructure2.default.uint32le),
  animations: new _nofs2.default(Animation),
  animationLookups: new _nofs2.default(),
  bones: new _nofs2.default(Bone),
  keyBoneLookups: new _nofs2.default(_restructure2.default.int16le),

  vertices: new _nofs2.default(Vertex),

  viewCount: _restructure2.default.uint32le,

  vertexColorAnimations: new _nofs2.default(Color),
  textures: new _nofs2.default(Texture),
  transparencyAnimations: new _nofs2.default(new _animationBlock2.default(_types.color16)),
  uvAnimations: new _nofs2.default(UVAnimation),
  replacableTextures: new _nofs2.default(),
  materials: new _nofs2.default(Material),
  boneLookups: new _nofs2.default(_restructure2.default.int16le),
  textureLookups: new _nofs2.default(_restructure2.default.int16le),
  textureMappings: new _nofs2.default(_restructure2.default.int16le),
  transparencyAnimationLookups: new _nofs2.default(_restructure2.default.int16le),
  uvAnimationLookups: new _nofs2.default(_restructure2.default.int16le),

  minVertexBox: _types.Vec3Float,
  maxVertexBox: _types.Vec3Float,
  vertexRadius: _restructure2.default.floatle,

  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  boundingRadius: _restructure2.default.floatle,

  boundingTriangles: new _nofs2.default(_restructure2.default.uint16le),
  boundingVertices: new _nofs2.default(_types.Vec3Float),
  boundingNormals: new _nofs2.default(_types.Vec3Float),
  attachments: new _nofs2.default(),
  attachmentLookups: new _nofs2.default(),
  events: new _nofs2.default(),
  lights: new _nofs2.default(),
  cameras: new _nofs2.default(),
  cameraLookups: new _nofs2.default(),
  ribbonEmitters: new _nofs2.default(),
  particleEmitters: new _nofs2.default(),

  blendingOverrides: new _restructure2.default.Optional(new _nofs2.default(_restructure2.default.uint16le), function () {
    return (this.flags & 0x08) !== 0;
  }),

  overrideBlending: function () {
    return (this.flags & 0x08) !== 0;
  },

  canInstance: function () {
    var instance = true;

    this.bones.forEach(bone => {
      if (bone.animated) {
        instance = false;
      }
    });

    return instance;
  },

  animated: function () {
    var animated = false;

    this.bones.forEach(bone => {
      if (bone.animated) {
        animated = true;
      }
    });

    this.uvAnimations.forEach(uvAnimation => {
      if (uvAnimation.animated) {
        animated = true;
      }
    });

    this.transparencyAnimations.forEach(transparency => {
      if (transparency.animated) {
        if (transparency.keyframeCount > 1) {
          animated = true;
        } else if (transparency.firstKeyframe.value !== 1.0) {
          animated = true;
        }
      }
    });

    this.vertexColorAnimations.forEach(color => {
      if (color.color.animated || color.alpha.animated) {
        animated = true;
      }
    });

    return animated;
  }
});
module.exports = exports['default'];