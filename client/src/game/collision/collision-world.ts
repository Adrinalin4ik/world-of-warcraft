import * as THREE from 'three';

import { castCapsuleAgainstTriangles } from './capsule-cast';
import { DoodadProvider } from './doodad-provider';
import { LiquidRegistry } from './liquid-query';
import { TerrainProvider } from './terrain-provider';
import { CastHit, CollisionLayer, LiquidClaim, Triangle } from './types';
import { WmoProvider } from './wmo-provider';

/**
 * A configured swept cast: origin (capsule centre), unit direction, max distance, optional skin,
 * and an optional floor filter (`minNormalZ`, see `capsule-cast.ts`).
 *
 * This is what every mover and camera function is handed -- never the world itself. That is what
 * keeps the whole movement stack testable against synthetic geometry with nothing loaded.
 */
export type CastFn = (
  from: THREE.Vector3, dir: THREE.Vector3, maxDist: number, skin?: number, minNormalZ?: number,
) => CastHit | null;

const _box = new THREE.Box3();

/** One recorded cast. See the trace block in `castFor`. */
interface CastRow {
  layer: CollisionLayer;
  /** Candidate triangles each provider contributed to THIS cast. */
  terrain: number;
  wmo: number;
  doodads: number;
  dist: number;
  /** The cast direction's Z, so a ground probe (-1) is distinguishable from a horizontal slide (0). */
  dirZ: number;
  hit: { distance: number; normalZ: number; source: string } | null;
}

/**
 * What produced a triangle, in one readable string.
 *
 * A WMO group view carries the file path it was built from, which is what makes a hit attributable to
 * a BUILDING rather than to "some object". The class name is the fallback and is enough to separate
 * the three providers.
 */
function describeSource(source: object): string {
  const named = source as { group?: { path?: string; index?: number } };
  if (typeof named.group?.path === 'string') {
    return `wmo ${named.group.path}#${named.group.index ?? 0}`;
  }
  return source.constructor?.name ?? 'unknown';
}

/**
 * The cast trace, on `window.castTrace`. Off by default; `enabled = true` to record.
 *
 * Bounded at 400 rows, which is a few seconds of walking: a frame issues six to eight casts and a
 * log that grew without limit would be a memory leak in an instrument.
 */
class CastTrace {
  enabled = false;

  rows: CastRow[] = [];

  record(row: CastRow): void {
    this.rows.push(row);
    if (this.rows.length > 400) {
      this.rows.splice(0, this.rows.length - 400);
    }
  }

  /** Every cast that gathered WMO faces -- the question this trace was built to answer. */
  get withWmo(): CastRow[] {
    return this.rows.filter((row) => row.wmo > 0);
  }

  /** Every cast whose HIT came from a WMO. */
  get hitWmo(): CastRow[] {
    return this.rows.filter((row) => row.hit !== null && row.hit.source.startsWith('wmo '));
  }

  clear(): void {
    this.rows = [];
  }
}

export const castTrace = new CastTrace();
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
    return (from, dir, maxDist, skin = 0, minNormalZ = -Infinity) => {
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
      const afterTerrain = candidates.length;
      this.wmo.gather(_box, layer, candidates);
      const afterWmo = candidates.length;
      this.doodads.gather(_box, candidates);

      const hit = castCapsuleAgainstTriangles(
        from, dir, maxDist, radius, halfSegment, candidates, skin, minNormalZ,
      );

      /**
       * THE PER-PROVIDER TRACE, and it exists because the movement trace could not answer the
       * question that was asked.
       *
       * The owner walks through WMOs. `moveTrace` records a contact's distance and normal but NOT
       * which provider produced it, so "no WMO contact" and "no contact at all" read identically --
       * and the floor he stands on may be terrain OR a WMO, which makes a successful ground snap no
       * evidence either way. He said so in three words and he was right.
       *
       * `Triangle.source` and `CastHit.source` have carried the answer all along (`types.ts:10-18`,
       * "Kept so a caller can tell what it is standing on"). Nothing was reading it.
       *
       * THE COUNTS ARE THE POINT, not the hit: `wmo` non-zero with no WMO hit says the broadphase
       * reached the faces and the sweep rejected them, which is a different file from `wmo` zero
       * while the debug overlay draws triangles at the same spot -- and that pair is exactly what
       * five rounds of reading could not separate.
       *
       * OFF BY DEFAULT and gated before any work: one boolean read per cast, and a frame runs several
       * (the slide's four iterations, the ground classify, the step-up, the camera boom). The two
       * `candidates.length` reads above are unconditional and are a number already in a register.
       */
      if (castTrace.enabled) {
        castTrace.record({
          layer,
          terrain: afterTerrain,
          wmo: afterWmo - afterTerrain,
          doodads: candidates.length - afterWmo,
          dist: maxDist,
          dirZ: dir.z,
          hit: hit === null ? null : {
            distance: hit.distance,
            normalZ: hit.normal.z,
            source: describeSource(hit.source),
          },
        });
      }
      return hit;
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

if (typeof window !== 'undefined') {
  // Reachable from the console: "is there any collision geometry near me, and from which provider"
  // is the first question every movement or camera report asks, and it is not answerable from the
  // scene graph -- collision comes from the BSP and the heightmap, not from what is drawn.
  (window as any).collisionWorld = collisionWorld;
  // The per-provider cast trace -- see the block in `castFor`. Off by default.
  (window as any).castTrace = castTrace;
}
