import * as r from 'restructure';

import { Vec3Float } from '../../types';
import AnimationBlock from '../animation-block';
import Nofs from '../nofs';

/**
 * Version-264 field sizes, in order:
 *   ribbonId 4, boneIndex 4, position 12, textureIndices 8, materialIndices 8,
 *   colorTrack 20, alphaTrack 20, heightAboveTrack 20, heightBelowTrack 20,
 *   edgesPerSecond 4, edgeLifetime 4, gravity 4, textureRows 2, textureCols 2,
 *   texSlotTrack 20, visibilityTrack 20,
 *   priorityPlane 2, ribbonColorIndex 1, textureTransformLookupIndex 1
 * = 176 bytes.
 */
export const RIBBON_SIZE = 176;

/**
 * M2Ribbon, transcribed from wowdev.wiki. Parsed for completeness; ribbon rendering is a later phase.
 */
const Ribbon = new r.Struct({
  ribbonId: r.uint32le,
  boneIndex: r.uint32le,
  position: Vec3Float,

  textureIndices: new Nofs(r.uint16le),
  materialIndices: new Nofs(r.uint16le),

  colorTrack: AnimationBlock(Vec3Float),
  alphaTrack: AnimationBlock(r.int16le),
  heightAboveTrack: AnimationBlock(r.floatle),
  heightBelowTrack: AnimationBlock(r.floatle),

  edgesPerSecond: r.floatle,
  edgeLifetime: r.floatle,
  gravity: r.floatle,
  textureRows: r.uint16le,
  textureCols: r.uint16le,

  texSlotTrack: AnimationBlock(r.uint16le),
  visibilityTrack: AnimationBlock(r.uint8),

  // Present from Wrath onward.
  priorityPlane: r.int16le,
  ribbonColorIndex: r.int8,
  textureTransformLookupIndex: r.int8
});

export default Ribbon;
