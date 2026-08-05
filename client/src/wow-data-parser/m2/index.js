import * as r from 'restructure';

import { color16, compfixed16array4, float32array2, float32array3, Vec3Float } from '../types';
import AnimationBlock from './animation-block';
import Nofs from './nofs';
import ParticleEmitter from './particle/emitter';
import Ribbon from './particle/ribbon';

const Animation = new r.Struct({
  id: r.uint16le,
  subID: r.uint16le,
  length: r.uint32le,
  movementSpeed: r.floatle,
  flags: r.uint32le,
  probability: r.int16le,

  unknowns: new r.Reserved(r.uint16le, 5),

  blendTime: r.uint32le,
  minBoundingBox: Vec3Float,
  maxBoundingBox: Vec3Float,
  boundingRadius: r.floatle,
  nextAnimationID: r.int16le,
  alias: r.uint16le
});

const Bone = new r.Struct({
  keyBoneID: r.int32le,
  flags: r.uint32le,
  parentID: r.int16le,
  submeshID: r.int16le,

  unknowns: new r.Reserved(r.uint16le, 2),

  translation: new AnimationBlock(float32array3, 'float32array3'),
  rotation: new AnimationBlock(compfixed16array4, 'compfixed16array4'),
  scaling: new AnimationBlock(float32array3, 'float32array3'),

  pivotPoint: float32array3,

  billboardType: function() {
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

  billboarded: function() {
    return this.billboardType !== null;
  },

  animated: function() {
    return this.translation.animated ||
           this.rotation.animated ||
           this.scaling.animated ||
           this.billboarded;
  }
});

const Material = new r.Struct({
  renderFlags: r.uint16le,
  blendingMode: r.uint16le
});

const Texture = new r.Struct({
  type: r.uint32le,
  flags: r.uint32le,
  length: r.uint32le,
  filename: new r.Pointer(r.uint32le, new r.String(null), 'global')
});

const Vertex = new r.Struct({
  position: float32array3,
  boneWeights: new r.Array(r.uint8, 4),
  boneIndices: new r.Array(r.uint8, 4),
  normal: float32array3,
  textureCoords: new r.Array(float32array2, 2)
});

const Color = new r.Struct({
  color: new AnimationBlock(float32array3, 'float32array3'),
  alpha: new AnimationBlock(color16, 'color16')
});

const UVAnimation = new r.Struct({
  translation: new AnimationBlock(float32array3, 'float32array3'),
  rotation: new AnimationBlock(compfixed16array4, 'compfixed16array4'),
  scaling: new AnimationBlock(float32array3, 'float32array3'),

  animated: function() {
    return this.translation.animated ||
      this.rotation.animated ||
      this.scaling.animated;
  }
});

/**
 * An `M2SplineKey<T>` -- value plus its two tangents. Camera position/target/roll tracks store
 * these ALWAYS, regardless of the block's interpolation type, so a key is 3x the value size.
 */
const SplineKeyVec3 = new r.Struct({
  value: float32array3,
  inTan: float32array3,
  outTan: float32array3
});

const SplineKeyFloat = new r.Struct({
  value: r.floatle,
  inTan: r.floatle,
  outTan: r.floatle
});

/**
 * One authored camera. `SetCamera(index)` in GlueXML indexes this array DIRECTLY -- the glue scene
 * models carry a single camera whose `cameraLookups` slot holds the 0xffff none sentinel, so the
 * portrait-style lookup path finds nothing there (benilla `models/records.rs#parse_m2_camera`).
 *
 * `fov` is the client's DIAGONAL opening angle, not a vertical FOV. The conversion for our aspect
 * lives in `game/ui/scene/scene-rig.ts#verticalFov`.
 */
export const Camera = new r.Struct({
  type: r.int32le,
  fov: r.floatle,
  farClip: r.floatle,
  nearClip: r.floatle,
  positions: new AnimationBlock(SplineKeyVec3),
  positionBase: float32array3,
  targetPositions: new AnimationBlock(SplineKeyVec3),
  targetBase: float32array3,
  roll: new AnimationBlock(SplineKeyFloat)
});

/**
 * An authored M2 light. `type` 0 is directional, 1 is an omnidirectional point light with the
 * engine's FIXED falloff `1 / (0.7d + 0.03d^2)` -- the authored attenuation range is a cull hint,
 * not the curve (benilla `models/records.rs`, byte-verified).
 *
 * For 3.3.5 glue scenes only the POINT lights matter: `glueparent.lua:50` states the directional
 * rig moved into the Lua `RaceLights` table for this build ("the models no longer contain
 * directional lights"), and `:361` confirms the engine "pulls the default point lights from the
 * models".
 */
export const Light = new r.Struct({
  type: r.uint16le,
  bone: r.int16le,
  position: float32array3,
  ambientColor: new AnimationBlock(float32array3),
  ambientIntensity: new AnimationBlock(r.floatle),
  diffuseColor: new AnimationBlock(float32array3),
  diffuseIntensity: new AnimationBlock(r.floatle),
  attenuationStart: new AnimationBlock(r.floatle),
  attenuationEnd: new AnimationBlock(r.floatle),
  visibility: new AnimationBlock(r.uint8)
});

/**
 * An attachment point. Records are addressed by ARRAY INDEX here; `attachmentLookups` maps an
 * attachment ID to that index. The glue screens' character stands on attachment **id 0** -- the
 * stage spot, on camera 0's axis in every UI_* scene (benilla byte-verified id 0, not 1).
 */
export const Attachment = new r.Struct({
  id: r.uint32le,
  bone: r.uint16le,
  unknown: r.uint16le,
  position: float32array3,
  animateAttached: new AnimationBlock(r.uint8)
});

export default new r.Struct({
  signature: new r.String(4),
  version: r.uint32le,

  names: new Nofs(new r.String()),
  name: function() {
    return this.names[0];
  },

  flags: r.uint32le,

  sequences: new Nofs(r.uint32le),
  animations: new Nofs(Animation),
  animationLookups: new Nofs(),
  bones: new Nofs(Bone),
  keyBoneLookups: new Nofs(r.int16le),

  vertices: new Nofs(Vertex),

  viewCount: r.uint32le,

  vertexColorAnimations: new Nofs(Color),
  textures: new Nofs(Texture),
  transparencyAnimations: new Nofs(new AnimationBlock(color16, 'color16')),
  uvAnimations: new Nofs(UVAnimation),
  replacableTextures: new Nofs(),
  materials: new Nofs(Material),
  boneLookups: new Nofs(r.int16le),
  textureLookups: new Nofs(r.int16le),
  textureMappings: new Nofs(r.int16le),
  transparencyAnimationLookups: new Nofs(r.int16le),
  uvAnimationLookups: new Nofs(r.int16le),

  minVertexBox: Vec3Float,
  maxVertexBox: Vec3Float,
  vertexRadius: r.floatle,

  minBoundingBox: Vec3Float,
  maxBoundingBox: Vec3Float,
  boundingRadius: r.floatle,

  boundingTriangles: new Nofs(r.uint16le),
  boundingVertices: new Nofs(Vec3Float),
  boundingNormals: new Nofs(Vec3Float),
  attachments: new Nofs(Attachment),
  attachmentLookups: new Nofs(r.int16le),
  events: new Nofs(),
  lights: new Nofs(Light),
  cameras: new Nofs(Camera),
  cameraLookups: new Nofs(r.int16le),
  ribbonEmitters: new Nofs(Ribbon),
  particleEmitters: new Nofs(ParticleEmitter),

  blendingOverrides: new r.Optional(new Nofs(r.uint16le), function() {
    return (this.flags & 0x08) !== 0;
  }),

  overrideBlending: function() {
    return (this.flags & 0x08) !== 0;
  },

  canInstance: function() {
    let instance = true;

    this.bones.forEach((bone) => {
      if (bone.animated) {
        instance = false;
      }
    });

    return instance;
  },

  animated: function() {
    let animated = false;

    this.bones.forEach((bone) => {
      if (bone.animated) {
        animated = true;
      }
    });

    this.uvAnimations.forEach((uvAnimation) => {
      if (uvAnimation.animated) {
        animated = true;
      }
    });

    this.transparencyAnimations.forEach((transparency) => {
      if (transparency.animated) {
        if (transparency.keyframeCount > 1) {
          animated = true;
        } else if (transparency.firstKeyframe.value !== 1.0) {
          animated = true;
        }
      }
    });

    this.vertexColorAnimations.forEach((color) => {
      if (color.color.animated || color.alpha.animated) {
        animated = true;
      }
    });

    return animated;
  }
});
