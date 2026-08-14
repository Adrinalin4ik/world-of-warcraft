import * as THREE from 'three';

import { collisionWorld } from '../collision/collision-world';
import { CollisionLayer, Triangle } from '../collision/types';

/**
 * The shared world-surface **decal projector** -- the reference's own ground-decal mechanism, ported.
 *
 * `benilla/src/decal.rs:1-23` (wow-re selection-circle RE section 2 + unit-blob-shadow RE, the
 * `0x6d7330` -> `0x6d6fa0` matrices -> `0x6d7480` emit chain): gather the triangles of every ground
 * receiving surface -- terrain tiles + WMO faces, **never** doodads -- whose bounds overlap a
 * projection box, clip each to the box (`clipToFrame`, Sutherland-Hodgman, the reference's
 * `clip_to_frame`), and emit them with planar top-down UVs.
 *
 * WHY THIS AND NOT A FLAT QUAD. The emitted triangles are exact sub-pieces of the drawn surfaces, so
 * the decal is coplanar with what is on screen: it follows a slope, drapes down a step and smears up
 * a ledge face, and it does that by construction rather than by a height probe. A single quad at the
 * unit's feet is wrong on any slope -- it either buries itself in the up-hill side or floats over the
 * down-hill one -- which is why round 20 declined to ship one.
 *
 * COORDINATE FRAME, and this is the one place it differs from the reference. benilla is Bevy, so its
 * horizontal plane is XZ and its vertical axis is Y. This client's world is **Z up**
 * (`pages/game/index.tsx:133` sets `camera.up = (0, 0, 1)`, and `collision/types.ts` calls a face
 * walkable on `normal.z`), so the horizontal plane here is XY and the vertical axis is Z. Every
 * `min_y/max_y` in `decal.rs` is `minZ/maxZ` here and its `min_z/max_z` is `minY/maxY`.
 *
 * DOODADS ARE DELIBERATELY NOT GATHERED, exactly as the reference states ("never
 * doodads/GameObjects"): a decal must pass *under* a prop, not climb it. That also keeps this away
 * from `collision/doodad-provider.ts` and the M2 hull entirely.
 */

/**
 * A decal's projection box: a yaw-rotated horizontal rectangle x a vertical slab, all relative to
 * `centre` (the owning object's feet). The horizontal bounds live in the **rotated frame**
 * (`x' = dx*cos - dy*sin`, `y' = dx*sin + dy*cos`), and the UV map takes `[minX, maxX] x [minY,
 * maxY]` onto `[0,1]^2` -- so the texture square IS this rectangle and a rotation of the frame is a
 * rotation of the texture. An axis-aligned box passes `(sin, cos) = (0, 1)`.
 */
export interface DecalFrame {
  /** World-space centre. Its `z` is the origin the vertical bounds are measured from. */
  centre: THREE.Vector3;
  sin: number;
  cos: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Vertical bounds relative to `centre.z` (`minZ` below, `maxZ` above). */
  minZ: number;
  maxZ: number;
}

/** The buffers a projection writes into. Cleared and refilled by `projectDecal`. */
export interface DecalMesh {
  /** World-space positions, 3 floats per vertex. */
  positions: Float32Array;
  /** Texture coordinates, 2 floats per vertex. */
  uvs: Float32Array;
  /** Per-vertex fade, 1 float per vertex. The caller multiplies its own tint in. */
  fades: Float32Array;
  /** How many vertices of the three arrays above are live. Always a multiple of 3. */
  count: number;
}

/** Allocate the buffers for at most `vertices` emitted vertices. */
export function decalMesh(vertices: number): DecalMesh {
  return {
    positions: new Float32Array(vertices * 3),
    uvs: new Float32Array(vertices * 2),
    fades: new Float32Array(vertices),
    count: 0,
  };
}

/**
 * In-frame horizontal coordinates of a world point -- the same rotation the UVs use.
 *
 * Writes into two module locals rather than returning a pair: this runs once per clipped vertex per
 * plane, six planes deep, and an object per call would allocate thousands of them a frame.
 */
let _fx = 0;
let _fy = 0;
function inFrame(frame: DecalFrame, x: number, y: number): void {
  const dx = x - frame.centre.x;
  const dy = y - frame.centre.y;
  _fx = dx * frame.cos - dy * frame.sin;
  _fy = dx * frame.sin + dy * frame.cos;
}

const _box = new THREE.Box3();
/** Reused candidate list: a projection allocates nothing here after the first call. */
const _candidates: Triangle[] = [];
/** The clip working set. Two buffers, ping-ponged across the six half-planes. */
const _poly: THREE.Vector3[] = [];
const _next: THREE.Vector3[] = [];
for (let i = 0; i < 16; ++i) {
  _poly.push(new THREE.Vector3());
  _next.push(new THREE.Vector3());
}

const _corner = new THREE.Vector3();
/** The four corner selectors, reused: `gatherBox` runs once per projection and allocates nothing. */
const _cornerX = [0, 0, 0, 0];
const _cornerY = [0, 0, 0, 0];

/** The world-axis-aligned gather box bounding the rotated frame (the broad phase). */
function gatherBox(frame: DecalFrame): THREE.Box3 {
  _box.makeEmpty();
  _cornerX[0] = frame.minX; _cornerY[0] = frame.minY;
  _cornerX[1] = frame.minX; _cornerY[1] = frame.maxY;
  _cornerX[2] = frame.maxX; _cornerY[2] = frame.minY;
  _cornerX[3] = frame.maxX; _cornerY[3] = frame.maxY;
  for (let i = 0; i < 4; ++i) {
    // Inverse of `inFrame`: world offset = R(-theta) . (x', y').
    const dx = _cornerX[i] * frame.cos + _cornerY[i] * frame.sin;
    const dy = _cornerY[i] * frame.cos - _cornerX[i] * frame.sin;
    _box.expandByPoint(
      _corner.set(frame.centre.x + dx, frame.centre.y + dy, frame.centre.z + frame.minZ),
    );
    _box.expandByPoint(
      _corner.set(frame.centre.x + dx, frame.centre.y + dy, frame.centre.z + frame.maxZ),
    );
  }
  return _box;
}

/**
 * Signed inside-distance of a point against one of the box's six half-planes.
 *
 * `plane` 0..3 are the rotated rectangle's edges, 4..5 the vertical slab. Written as one switch
 * rather than six closures because this runs per clipped vertex per plane per triangle.
 */
function planeDistance(frame: DecalFrame, plane: number, p: THREE.Vector3): number {
  if (plane === 4) {
    return frame.centre.z + frame.maxZ - p.z;
  }
  if (plane === 5) {
    return p.z - (frame.centre.z + frame.minZ);
  }
  inFrame(frame, p.x, p.y);
  switch (plane) {
    case 0:
      return frame.maxX - _fx;
    case 1:
      return _fx - frame.minX;
    case 2:
      return frame.maxY - _fy;
    default:
      return _fy - frame.minY;
  }
}

/**
 * Sutherland-Hodgman clip of one triangle against the frame's box (the reference's `clip_to_frame`).
 *
 * Clipping happens in the ROTATED frame, which is exactly the texture frame -- so every emitted UV
 * stays inside `[0,1]` and the texture can never wrap a ghost copy in at a corner. Positions are
 * interpolated in full 3D along a clipped edge, so the result stays on the source triangle's plane,
 * which is what makes the decal coplanar with the drawn ground.
 *
 * Returns the live vertex count in `_poly`, 0 when the triangle is outside the box. A clipped convex
 * polygon of a triangle against six planes cannot exceed 9 vertices, so the 16-slot working set
 * cannot overflow; the guard is there so a malformed frame degrades to "nothing drawn".
 */
function clipToFrame(frame: DecalFrame, tri: Triangle): number {
  _poly[0].copy(tri.a);
  _poly[1].copy(tri.b);
  _poly[2].copy(tri.c);
  let count = 3;

  for (let plane = 0; plane < 6; ++plane) {
    let out = 0;
    for (let i = 0; i < count; ++i) {
      const a = _poly[i];
      const b = _poly[(i + 1) % count];
      const da = planeDistance(frame, plane, a);
      const db = planeDistance(frame, plane, b);
      if (da >= 0) {
        if (out >= _next.length) {
          return 0;
        }
        _next[out++].copy(a);
      }
      if (da >= 0 !== db >= 0) {
        if (out >= _next.length) {
          return 0;
        }
        _next[out++].lerpVectors(a, b, da / (da - db));
      }
    }
    count = out;
    if (count < 3) {
      return 0;
    }
    for (let i = 0; i < count; ++i) {
      _poly[i].copy(_next[i]);
    }
  }

  return count;
}

/**
 * Project a surface decal into `mesh` as world-space, fan-unrolled triangles.
 *
 * `fade` computes a vertex's own alpha from its in-frame position (`x'`, `y'`, and `dz` = height
 * above the frame centre) -- the vertical ramp that keeps a smear up a wall from ending in a hard
 * clip line. `uv` maps in-frame `(x', y')` to a texture coordinate.
 *
 * Returns `false` when nothing was gathered (no receiving surface in the box: mid-air, or a tile that
 * has not streamed in). The caller hides the decal, which is the reference's own no-ground gate
 * (`decal.rs:104-105`, `0x6d74b5` -- the whole draw is skipped).
 */
export function projectDecal(
  mesh: DecalMesh,
  frame: DecalFrame,
  fade: (x: number, y: number, dz: number) => number,
  uv: (x: number, y: number) => [number, number],
): boolean {
  mesh.count = 0;
  if (frame.maxX - frame.minX <= 0 || frame.maxY - frame.minY <= 0) {
    return false;
  }

  const box = gatherBox(frame);
  const candidates = _candidates;
  candidates.length = 0;
  collisionWorld.terrain.gather(box, candidates);
  // The WALK audience, not Camera: it is the one that rejects MOPY detail faces
  // (`collision/layers.ts:28`), i.e. the render-only clutter you cannot stand on. A decal wants the
  // floor a player stands on, so the two questions have the same answer.
  collisionWorld.wmo.gather(box, CollisionLayer.Walk, candidates);

  const maxVertices = mesh.fades.length;
  for (let t = 0; t < candidates.length; ++t) {
    const clipped = clipToFrame(frame, candidates[t]);
    if (clipped < 3) {
      continue;
    }
    for (let k = 1; k < clipped - 1; ++k) {
      if (mesh.count + 3 > maxVertices) {
        // Budget exhausted. Whatever was emitted is still coplanar and still drawn, so the ring is
        // partially there rather than absent -- a visible tell instead of a silent disappearance.
        return mesh.count > 0;
      }
      for (let corner = 0; corner < 3; ++corner) {
        const p = _poly[corner === 0 ? 0 : k + corner - 1];
        inFrame(frame, p.x, p.y);
        const fx = _fx;
        const fy = _fy;
        const [u, v] = uv(fx, fy);
        const i = mesh.count;
        mesh.positions[i * 3] = p.x;
        mesh.positions[i * 3 + 1] = p.y;
        mesh.positions[i * 3 + 2] = p.z;
        mesh.uvs[i * 2] = u;
        mesh.uvs[i * 2 + 1] = v;
        mesh.fades[i] = fade(fx, fy, p.z - frame.centre.z);
        mesh.count = i + 1;
      }
    }
  }

  return mesh.count > 0;
}

/** The frame's default UV map: the texture square IS the frame rectangle. */
export function rectUv(frame: DecalFrame, x: number, y: number): [number, number] {
  return [
    (x - frame.minX) / (frame.maxX - frame.minX),
    (y - frame.minY) / (frame.maxY - frame.minY),
  ];
}
