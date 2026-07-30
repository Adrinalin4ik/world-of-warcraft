import * as r from 'restructure';

import { float32array2, Vec3Float } from '../../types';
import AnimationBlock from '../animation-block';
import Nofs from '../nofs';
import FBlock from './part-track';

/** Sum of the version-264 field list below. The layout's canary; see the plan. */
export const PARTICLE_EMITTER_SIZE = 476;

export const EMITTER_TYPE = { PLANE: 1, SPHERE: 2, SPLINE: 3, BONE: 4 };

/**
 * M2Particle for version 264 (WotLK).
 *
 * Transcribed from wowdev.wiki's M2ParticleOld. Version 264 takes every `>= Wrath` branch and no
 * `>= Cata` branch, so: textureId is a plain uint16 rather than three packed 5-bit indices,
 * particleType and headOrTail are still present, colour/alpha/scale are FBlocks rather than fixed
 * three-element arrays, and spin is four floats rather than one.
 */
const ParticleEmitter = new r.Struct({
  particleId: r.uint32le,
  flags: r.uint32le,
  position: Vec3Float,
  boneId: r.uint16le,
  textureId: r.uint16le,

  particleModelFilename: new Nofs(r.uint8),
  childEmittersModelFilename: new Nofs(r.uint8),

  blendingType: r.uint8,
  emitterType: r.uint8,
  particleColorIndex: r.uint16le,

  particleType: r.uint8,
  headOrTail: r.uint8,

  priorityPlane: r.int16le,
  rows: r.uint16le,
  columns: r.uint16le,

  emissionSpeed: AnimationBlock(r.floatle),
  speedVariation: AnimationBlock(r.floatle),
  verticalRange: AnimationBlock(r.floatle),
  horizontalRange: AnimationBlock(r.floatle),
  gravity: AnimationBlock(r.floatle),
  lifespan: AnimationBlock(r.floatle),
  lifespanVariation: r.floatle,
  emissionRate: AnimationBlock(r.floatle),
  emissionRateVariation: r.floatle,
  emissionAreaWidth: AnimationBlock(r.floatle),
  emissionAreaLength: AnimationBlock(r.floatle),
  zSource: AnimationBlock(r.floatle),

  colorTrack: FBlock(Vec3Float),
  // Raw int16 in 0..32767 (fixed16). A consumer must divide by FIXED16_SCALE (see part-track.js)
  // to get the 0..1 alpha fraction; this parser does not decode it.
  alphaTrack: FBlock(r.int16le),
  scaleTrack: FBlock(float32array2),
  scaleVary: float32array2,
  headUVAnim: FBlock(r.uint16le),
  tailUVAnim: FBlock(r.uint16le),

  tailLength: r.floatle,
  twinkleSpeed: r.floatle,
  twinklePercent: r.floatle,
  twinkleScaleMin: r.floatle,
  twinkleScaleMax: r.floatle,
  // wowdev calls this field burstMultiplier.
  inheritVelocityScale: r.floatle,
  drag: r.floatle,

  baseSpin: r.floatle,
  baseSpinVariation: r.floatle,
  spinSpeed: r.floatle,
  spinSpeedVariation: r.floatle,

  tumbleMin: Vec3Float,
  tumbleMax: Vec3Float,

  windVector: Vec3Float,
  windTime: r.floatle,

  followSpeed1: r.floatle,
  followScale1: r.floatle,
  followSpeed2: r.floatle,
  followScale2: r.floatle,

  splinePoints: new Nofs(Vec3Float),

  enabledIn: AnimationBlock(r.uint8)
});

export default ParticleEmitter;
