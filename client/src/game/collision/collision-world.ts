import * as THREE from 'three';

import { castCapsuleAgainstTriangles } from './capsule-cast';
import { DoodadProvider } from './doodad-provider';
import { LiquidRegistry } from './liquid-query';
import { TerrainProvider } from './terrain-provider';
import { CastHit, CollisionLayer, LiquidClaim, Triangle } from './types';
import { WmoProvider } from './wmo-provider';

/**
 * A configured swept cast: origin (capsule centre), unit direction, max distance, optional skin.
 *
 * This is what every mover and camera function is handed -- never the world itself. That is what
 * keeps the whole movement stack testable against synthetic geometry with nothing loaded.
 */
export type CastFn = (
  from: THREE.Vector3, dir: THREE.Vector3, maxDist: number, skin?: number,
) => CastHit | null;

const _box = new THREE.Box3();
const _end = new THREE.Vector3();

/**
 * Owns the candidate providers and turns them into the two things the rest of the game asks for: a
 * swept capsule cast, and a liquid surface height.
 *
 * Replaces `ColliderManager`, which was a flat Map of every mesh in the world plus an empty merged
 * mesh nothing ever filled -- so collision was, in practice, dead code.
 */
export class CollisionWorld {
  readonly terrain = new TerrainProvider();

  readonly wmo = new WmoProvider();

  readonly doodads = new DoodadProvider();

  readonly liquid = new LiquidRegistry();

  /** Scratch candidate list, reused every cast so a frame allocates nothing here. */
  private candidates: Triangle[] = [];

  clear(): void {
    this.terrain.clear();
    this.wmo.clear();
    this.doodads.clear();
    this.liquid.clear();
  }

  /**
   * Build the cast closure for one audience and one capsule shape. The returned function gathers
   * candidates for the swept volume, then runs the swept capsule over them.
   */
  castFor(layer: CollisionLayer, radius: number, halfSegment: number): CastFn {
    return (from, dir, maxDist, skin = 0) => {
      const candidates = this.candidates;
      candidates.length = 0;

      // The broadphase box must cover the WHOLE sweep, not just its origin: a cast that gathered
      // around `from` alone would sail through anything more than a capsule-width away, which is
      // every wall a running step reaches.
      _end.copy(dir).multiplyScalar(maxDist).add(from);
      _box.makeEmpty().expandByPoint(from).expandByPoint(_end);
      const pad = radius + halfSegment + 0.5;
      _box.min.subScalar(pad);
      _box.max.addScalar(pad);

      this.terrain.gather(_box, candidates);
      this.wmo.gather(_box, layer, candidates);
      this.doodads.gather(_box, candidates);

      return castCapsuleAgainstTriangles(
        from, dir, maxDist, radius, halfSegment, candidates, skin,
      );
    };
  }

  surfaceAt(x: number, y: number, claim: LiquidClaim) {
    return this.liquid.surfaceAt(x, y, claim);
  }
}

/**
 * The process-wide world the streaming hooks register geometry with.
 *
 * Only integration code -- the terrain/WMO/M2 managers and the per-frame controller -- should touch
 * this. Movement and camera functions take a `CastFn` parameter instead, which is what lets the
 * whole rule set be unit-tested with no world loaded.
 */
export const collisionWorld = new CollisionWorld();
