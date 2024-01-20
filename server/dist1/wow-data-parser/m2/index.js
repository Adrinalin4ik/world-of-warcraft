'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _types = require('../types');

var _animationBlock = require('./animation-block');

var _animationBlock2 = _interopRequireDefault(_animationBlock);

var _nofs = require('./nofs');

var _nofs2 = _interopRequireDefault(_nofs);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

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

var Material = new r.Struct({
  renderFlags: r.uint16le,
  blendingMode: r.uint16le
});

var Texture = new r.Struct({
  type: r.uint32le,
  flags: r.uint32le,
  length: r.uint32le,
  filename: new r.Pointer(r.uint32le, new r.String(null), { type: 'global' })
});

var Vertex = new r.Struct({
  position: _types.float32array3,
  boneWeights: new r.Array(r.uint8, 4),
  boneIndices: new r.Array(r.uint8, 4),
  normal: _types.float32array3,
  textureCoords: new r.Array(_types.float32array2, 2)
});

var Color = new r.Struct({
  color: new _animationBlock2.default(_types.float32array3),
  alpha: new _animationBlock2.default(_types.color16)
});

var UVAnimation = new r.Struct({
  translation: new _animationBlock2.default(_types.float32array3),
  rotation: new _animationBlock2.default(_types.compfixed16array4),
  scaling: new _animationBlock2.default(_types.float32array3),

  animated: function () {
    return this.translation.animated || this.rotation.animated || this.scaling.animated;
  }
});

exports.default = new r.Struct({
  signature: new r.String(4),
  version: r.uint32le,

  names: new _nofs2.default(new r.String()),
  name: function () {
    return this.names[0];
  },

  flags: r.uint32le,

  sequences: new _nofs2.default(r.uint32le),
  animations: new _nofs2.default(Animation),
  animationLookups: new _nofs2.default(),
  bones: new _nofs2.default(Bone),
  keyBoneLookups: new _nofs2.default(r.int16le),

  vertices: new _nofs2.default(Vertex),

  viewCount: r.uint32le,

  vertexColorAnimations: new _nofs2.default(Color),
  textures: new _nofs2.default(Texture),
  transparencyAnimations: new _nofs2.default(new _animationBlock2.default(_types.color16)),
  uvAnimations: new _nofs2.default(UVAnimation),
  replacableTextures: new _nofs2.default(),
  materials: new _nofs2.default(Material),
  boneLookups: new _nofs2.default(r.int16le),
  textureLookups: new _nofs2.default(r.int16le),
  textureMappings: new _nofs2.default(r.int16le),
  transparencyAnimationLookups: new _nofs2.default(r.int16le),
  uvAnimationLookups: new _nofs2.default(r.int16le),

  minVertexBox: _types.Vec3Float,
  maxVertexBox: _types.Vec3Float,
  vertexRadius: r.floatle,

  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  boundingRadius: r.floatle,

  boundingTriangles: new _nofs2.default(r.uint16le),
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

  blendingOverrides: new r.Optional(new _nofs2.default(r.uint16le), function () {
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