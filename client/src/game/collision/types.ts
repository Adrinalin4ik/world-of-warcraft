import * as THREE from 'three';

/**
 * One candidate collision triangle in WORLD space, with its face normal precomputed.
 *
 * The movement rules are all normal-driven -- walkable iff `normal.z >= GROUND_COS`, the steep-wall
 * flatten, the step-vs-fall election snap -- so the normal travels with the triangle rather than
 * being recomputed on every query.
 *
 * `source` is whatever produced it: a terrain Chunk, a WMO group view, an M2 bounding hull. Kept so
 * a caller can tell what it is standing on, which is what a transport attach would key off.
 */
export interface Triangle {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  normal: THREE.Vector3;
  source: object;
}

/** What a swept capsule cast found. */
export interface CastHit {
  /** Distance travelled along the cast direction before contact (yards). Never negative. */
  distance: number;
  /** The contacted face's outward normal. */
  normal: THREE.Vector3;
  /** The `Triangle.source` of the contacted face. */
  source: object;
}

/**
 * The two collision AUDIENCES. Terrain and doodads belong to both; only WMO faces are filtered, and
 * they are filtered differently for each.
 */
export enum CollisionLayer {
  Walk = 'walk',
  Camera = 'camera',
}

/**
 * Which room's liquid answers a surface query.
 *
 * Inside a WMO group only THAT placement's own MLIQ answers; outdoors only the ADT's. Without the
 * scoping, a building's floor liquid answers for someone standing outside it and the ADT's answers
 * for someone inside -- which is how a player ends up swimming in mid-air.
 */
export interface LiquidClaim {
  /** The WMO group the player is currently inside, or null when outdoors. */
  wmoGroup: object | null;
}
