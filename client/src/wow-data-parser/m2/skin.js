import * as r from 'restructure';

import { Vec3Float } from '../types';
import Nofs from './nofs';

const Submesh = new r.Struct({
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
  centerMass: Vec3Float,
  centerBoundingBox: Vec3Float,
  radius: r.floatle
});

/**
 * M2Batch. **`flags` IS ONE BYTE, NOT TWO** -- the second byte is `priorityPlane`, and reading them
 * as a single `uint16le` both hid the plane and polluted the flag word with it.
 *
 * The real layout is `uint8 flags; int8 priorityPlane;` followed by eleven `uint16`s = 24 bytes,
 * which is exactly what the old twelve-`uint16` reading also summed to -- so the record size canary
 * could NOT catch this one, and nothing downstream complained because nothing reads `flags` at all
 * (grepped: the only mention in the tree is a comment). The plane was simply invisible.
 *
 * Measured on the served build before changing it: of 214 batches across 22 decoded `.skin` files,
 * **4 (1.9%) author a non-zero plane** -- so `flags` was silently reading `0x01xx` and worse on those,
 * and any future flag test would have been wrong on 1 batch in 50. `DemonArmor_Impact_Head`'s two
 * batches both author plane 0.
 *
 * `priorityPlane` is the per-batch render-order key, the mesh-side twin of `M2Particle.priorityPlane`
 * (`particle/emitter.js:38`). Nothing consumes it yet and this does not wire it up -- see
 * `world/spell-kit-effects.ts` on why the ordering question it belongs to is not settled by it.
 */
const Batch = new r.Struct({
  flags: r.uint8,
  priorityPlane: r.int8,
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

export default new r.Struct({
  signature: new r.String(4),
  indices: new Nofs(r.uint16le),
  triangles: new Nofs(r.uint16le),
  boneIndices: new Nofs(new r.Array(r.uint8, 4)),
  submeshes: new Nofs(Submesh),
  batches: new Nofs(Batch),
  boneCount: r.uint32le
});
