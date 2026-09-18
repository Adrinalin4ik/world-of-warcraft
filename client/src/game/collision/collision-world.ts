import * as THREE from 'three';

import { CAPSULE_CAST_EPS, castCapsuleAgainstTriangles, depenetrateCapsule } from './capsule-cast';
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

/** Scratch for the push-out report -- see `pushOut.lastSource`. */
const _penInfo: { source: object | null; normalZ: number; gap: number } = {
  source: null, normalZ: 0, gap: 0,
};

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
 * **BOUNDED AT 4000 ROWS, AND 400 WAS TOO FEW TO ANSWER THE QUESTION.** A frame issues six to eight
 * casts, so 400 rows is about fifty frames -- and the owner cannot type in the console while holding
 * W. By the time he read the trace, the horizontal slide casts had been evicted by the standing
 * ground probes that followed, and the summary said `withWmo 400 / hitWmo 0` with no horizontal cast
 * in the buffer at all. The window was shorter than the gesture, which is the same mistake the
 * `moveTrace` slice made one round earlier.
 *
 * 4000 is about eight seconds of walking, still bounded, and a row is five numbers and a short string.
 */
class CastTrace {
  enabled = false;

  rows: CastRow[] = [];

  record(row: CastRow): void {
    this.rows.push(row);
    if (this.rows.length > 4000) {
      this.rows.splice(0, this.rows.length - 4000);
    }
  }

  /** Every cast that gathered WMO faces -- the question this trace was built to answer. */
  get withWmo(): CastRow[] {
    return this.rows.filter((row) => row.wmo > 0);
  }

  /**
   * The HORIZONTAL casts -- the slide, and the only ones that can stop a body at a wall.
   *
   * A ground probe points straight down and a camera boom points wherever the camera is; neither can
   * tell you anything about walking into a building. Separating them is the first thing to ask for,
   * so it is a getter rather than a filter the reader has to remember.
   */
  get horizontal(): CastRow[] {
    return this.rows.filter((row) => Math.abs(row.dirZ) < 1e-6);
  }

  /**
   * One line that says what the buffer actually holds, by cast SHAPE.
   *
   * Built because the first reading of this trace was ambiguous in a way the reader could not see: a
   * summary of 400 rows that were all ground probes looks exactly like a summary of 400 rows that
   * include the slide. Counting them apart makes an empty horizontal set visible immediately instead
   * of after a second round trip.
   */
  get shape(): { rows: number; horizontal: number; down: number; other: number } {
    const horizontal = this.horizontal.length;
    const down = this.rows.filter((row) => row.dirZ < -1e-6).length;
    return {
      rows: this.rows.length,
      horizontal,
      down,
      other: this.rows.length - horizontal - down,
    };
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

/**
 * **THE ALWAYS-ON CANDIDATE CENSUS -- `window.castCensus()`.**
 *
 * The owner is at `ctl.move` **10.2 ms while standing still**, against the 3.8 ms this file's own
 * records establish. Attribution needs the CANDIDATE COUNT, because the cost model here is already
 * written down and it is linear in that count: "a cast gathered 249 to 336 WMO triangles, a movement
 * frame issues about ten casts ... and that is some three thousand capsule-triangle solves a frame --
 * which is `ctl.move` at 3.8 ms almost exactly" (the pad note above). So candidates per frame IS the
 * finding, and nothing measured it.
 *
 * `castTrace` cannot answer it: it is arm-and-read, it allocates a row per cast, and this file
 * already records what that costs -- "an instrument costing as much as the thing it measures, in the
 * one section (`ctl.move`) the owner and I are trying to read" (`mover.ts`). This is the cheap twin:
 * **integer increments only**, on numbers the cast path had already computed for `castTrace` anyway,
 * so an unarmed frame pays four adds per cast and nothing else. No allocation, no clock reads.
 *
 * The two paths are counted SEPARATELY because they are separate gathers with different boxes -- the
 * swept `cast` and the frame-start `depenetrate` push-out -- and at rest the push-out is one of only
 * three cast-equivalents the mover runs, so lumping them would hide which one is expensive.
 *
 * The PROVIDER SPLIT is the point: terrain, WMO and doodads are three different broadphases, and
 * which of them returns the bulk of the candidates names the target. A doodad-dominated census with
 * 145 doodads visible is a different defect from a terrain-dominated one.
 */
const castCensus = {
  frames: 0,
  casts: 0,
  castTerrain: 0,
  castWmo: 0,
  castDoodads: 0,
  pushOuts: 0,
  pushTerrain: 0,
  pushWmo: 0,
  pushDoodads: 0,
  /** Ring of `ctl.move` durations in ms, fed by `noteMovementFrame`. */
  moveMs: [] as number[],
};

/**
 * Count one movement frame, so the census can report PER-FRAME totals rather than per-cast alone.
 *
 * Called from `Controls#update` inside the `ctl.move` span -- the same span the owner's number comes
 * from, so the two describe exactly the same work.
 */
export function noteMovementFrame(ms?: number): void {
  castCensus.frames += 1;
  if (ms !== undefined) {
    castCensus.moveMs.push(ms);
    if (castCensus.moveMs.length > 512) {
      castCensus.moveMs.shift();
    }
  }
}

/**
 * The movement phase census, injected rather than imported.
 *
 * `game/movement` already imports `CastFn` from this module, so importing the phase census the other
 * way would close a cycle. A registered sink is the pattern this codebase uses for exactly that --
 * `movement/outbound.ts#setMovementSink`, `classes/cast-cancel.ts#setCastBarTeardown` -- and it keeps
 * `moveProfile()` a single paste rather than two commands the owner has to correlate.
 */
let movePhases: {
  read: (frames: number) => Record<string, unknown>;
  reset: () => void;
} | null = null;

export function setMovePhaseSource(source: typeof movePhases): void {
  movePhases = source;
}

/**
 * Mean of a numeric ring, or null when it is empty.
 *
 * A mean and not a median, for the reason `gatherUs` gives at length: the clock here is quantised to
 * 100 us, so a median of sub-100-us samples reports the quantum and a mean converges on the value.
 * `ctlMoveMs` is in MILLISECONDS and is ~4.6, so 100 us is a 2% resolution on it -- fine either way.
 */
function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total / values.length;
}

/**
 * **THE ONE-PASTE A/B READOUT -- `window.moveProfile()`.**
 *
 * The owner's five at-rest `ctl.move` samples are 4.1, 6.1, 10.2, 4.7 and 9.3 ms: a 2.5x spread that
 * no 2.7 ms change can be seen inside, and `CLAUDE.md` records exactly that failure -- run-to-run
 * spread has repeatedly covered an entire claimed change here. Two readings at two locations across a
 * page reload cannot settle anything, and asking a person to hold a location constant across a reload
 * is a bad instrument.
 *
 * So this makes the comparison happen in ONE sitting at ONE spot with the registered set unchanged,
 * where the arms differ only in `collisionWorld.terrain.broadphase`:
 *
 *     moveProfile()                                  // arm A, broadphase on
 *     collisionWorld.terrain.broadphase = false
 *     moveProfileReset(); // stand still ~10 s
 *     moveProfile()                                  // arm B, the all-chunks walk
 *
 * **`gatherUs` is the arm that settles it and it carries no extrapolation.** It is the median cost of
 * ONE gather on his machine at his chunk count. The offline bench's 8.4 us per untouched chunk was
 * measured at 64 chunks on another machine; extrapolated to his 441 it would predict ~18.5 ms a frame
 * from this term alone, which his pre-fix `ctl.move` never approached -- so the bench gives the SHAPE
 * and not the SIZE, and this is the size.
 *
 * `broadphase` appearing in the output at all also identifies the build: if
 * `collisionWorld.terrain.broadphase` is `undefined`, the page is running a bundle from before the
 * fix and no number below means anything yet.
 */
function readMoveProfile() {
  const n = Math.max(castCensus.frames, 1);
  const per = (total: number) => Math.round((total / n) * 10) / 10;
  const t = collisionWorld.terrain;
  const gathers = Math.max(t.census.gathers, 1);
  const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
  return {
    // Arm identity and the two inputs that MUST match between the two reads for the pair to mean
    // anything. A different `registeredChunks` between arms invalidates the comparison outright.
    broadphase: t.broadphase,
    registeredChunks: t.size,
    frames: castCensus.frames,

    /**
     * **A MEAN, NOT A MEDIAN -- and the median was a defect in this instrument.**
     *
     * `performance.now()` on the owner's browser is quantised to **100 us**. Every single-gather
     * sample therefore reads either `0` or `100`, so a MEDIAN of them reads 0 or exactly 100 and
     * measures the clock rather than the gather -- which is precisely what came back: `0` on a
     * 2203-frame arm and exactly `100` on two shorter ones. A mean over the accumulated sum
     * converges instead, because which side of a 100 us boundary a call lands on is unbiased across
     * many calls.
     *
     * Even so this cannot resolve better than about `100 / sqrt(samples)` us, so it is reported
     * alongside `perGather.chunksVisited`, which is exact and needs no clock at all.
     */
    gatherUs: t.census.gathers === 0
      ? null
      : Math.round((t.census.usTotal / t.census.gathers) * 100) / 100,
    ctlMoveMs: round2(mean(castCensus.moveMs)),

    perFrame: {
      gathers: per(t.census.gathers),
      casts: per(castCensus.casts),
      pushOuts: per(castCensus.pushOuts),
      candidates: per(
        castCensus.castTerrain + castCensus.castWmo + castCensus.castDoodads
        + castCensus.pushTerrain + castCensus.pushWmo + castCensus.pushDoodads,
      ),
    },
    /**
     * **WHERE THE OTHER ~90% GOES.** The A/B settled that the gather is 0.4 ms of a 4.6 ms section,
     * so this is the split that finds the rest -- means, not medians, over the 100 us clock. A large
     * `unaccountedUsPerFrame` with no dominant phase is itself a legitimate answer: the mover costs
     * what it costs, spread thinly.
     */
    phases: movePhases === null ? 'not wired' : movePhases.read(castCensus.frames),
    perGather: {
      chunksVisited: Math.round((t.census.visited / gathers) * 10) / 10,
      chunksRejected: Math.round((t.census.rejected / gathers) * 10) / 10,
    },
    /**
     * **THE WMO PROVIDER, the last gather that was still dark.** `gatherUs` times only the terrain
     * provider, so a WMO cost could not have shown up in any earlier arm -- and `perCast.wmo`
     * reading 0 candidates does not mean 0 cost, which is exactly the lesson the doodad provider
     * taught: 1509 hulls walked to return 3 candidates.
     *
     * Integers, no clock. `refreshesPerFrame` is the one that matters and it is the gate on the
     * settle latch: it must fall to **0** once the resident groups have been placed for two frames.
     * MEASURED after the latch landed: **0**, with `registered: 318`.
     *
     * `registered` is the line that corrected the estimate, and by 30x: the latch was predicted to
     * save little on the grounds of "8-11 groups", which was the `visibleGroups` render figure and
     * not this one. 318 groups x 4 gathers is **1272 refreshes a frame** removed, not 35. See
     * `wmo-provider.ts#census` -- reasoning about a per-frame collision cost from a VISIBLE count
     * has now been wrong twice, here and for `terrain.size`.
     *
     * `visitedPerGather` 318 against `rejectedPerGather` 318 is the next structural item and is
     * deliberately not chased: every group is rejected by the cheap world-box test, so the walk now
     * costs only a matrix compare and a box overlap per group -- but it is still O(registry) per
     * gather, and a spatial index over the three registries is the fix rather than a tweak.
     */
    wmo: {
      registered: collisionWorld.wmo.size,
      gathersPerFrame: per(collisionWorld.wmo.census.gathers),
      visitedPerGather: collisionWorld.wmo.census.gathers === 0
        ? 0
        : Math.round((collisionWorld.wmo.census.visited / collisionWorld.wmo.census.gathers) * 10) / 10,
      rejectedPerGather: collisionWorld.wmo.census.gathers === 0
        ? 0
        : Math.round((collisionWorld.wmo.census.rejected / collisionWorld.wmo.census.gathers) * 10) / 10,
      refreshesPerFrame: per(collisionWorld.wmo.census.refreshes),
    },
    /**
     * THE LIQUID PROVIDER, never instrumented until now and the one caller the earlier execution
     * list missed: `frame.ts`'s `surfaceAt` goes to `LiquidRegistry`, NOT to the terrain provider, so
     * it is not one of the four gathers already counted. `surfaceAt` walks every registered surface
     * and `heightOn` pays a 4x4 matrix inversion per visit, which is the same shape as the terrain
     * defect in a provider nobody had looked at. `visitedPerCall` is exact and needs no clock.
     */
    liquid: {
      registered: collisionWorld.liquid.census.registered,
      callsPerFrame: per(collisionWorld.liquid.census.calls),
      visitedPerCall: collisionWorld.liquid.census.calls === 0
        ? 0
        : Math.round((collisionWorld.liquid.census.visited / collisionWorld.liquid.census.calls) * 10) / 10,
    },
  };
}

/** Clear both censuses, so each A/B arm measures its own window. */
function resetMoveProfile(): void {
  resetCastCensus();
  const t = collisionWorld.terrain;
  t.census.gathers = 0;
  t.census.visited = 0;
  t.census.rejected = 0;
  t.census.usTotal = 0;
  collisionWorld.liquid.census.calls = 0;
  collisionWorld.liquid.census.visited = 0;
  const w = collisionWorld.wmo.census;
  w.gathers = 0;
  w.visited = 0;
  w.rejected = 0;
  w.refreshes = 0;
  movePhases?.reset();
}

function readCastCensus() {
  const n = Math.max(castCensus.frames, 1);
  const per = (total: number) => Math.round((total / n) * 10) / 10;
  const each = (total: number, calls: number) => Math.round((total / Math.max(calls, 1)) * 10) / 10;
  const castTotal = castCensus.castTerrain + castCensus.castWmo + castCensus.castDoodads;
  const pushTotal = castCensus.pushTerrain + castCensus.pushWmo + castCensus.pushDoodads;
  return {
    frames: castCensus.frames,
    perFrame: {
      casts: per(castCensus.casts),
      pushOuts: per(castCensus.pushOuts),
      // THE HEADLINE. Compare against the ~3000 the 3.8 ms baseline was measured at.
      candidates: per(castTotal + pushTotal),
    },
    perCast: {
      terrain: each(castCensus.castTerrain, castCensus.casts),
      wmo: each(castCensus.castWmo, castCensus.casts),
      doodads: each(castCensus.castDoodads, castCensus.casts),
      total: each(castTotal, castCensus.casts),
    },
    perPushOut: {
      terrain: each(castCensus.pushTerrain, castCensus.pushOuts),
      wmo: each(castCensus.pushWmo, castCensus.pushOuts),
      doodads: each(castCensus.pushDoodads, castCensus.pushOuts),
      total: each(pushTotal, castCensus.pushOuts),
    },
  };
}

function resetCastCensus(): void {
  castCensus.frames = 0;
  castCensus.casts = 0;
  castCensus.castTerrain = 0;
  castCensus.castWmo = 0;
  castCensus.castDoodads = 0;
  castCensus.pushOuts = 0;
  castCensus.pushTerrain = 0;
  castCensus.pushWmo = 0;
  castCensus.pushDoodads = 0;
  castCensus.moveMs.length = 0;
}
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

  /**
   * Providers a cast should pretend do not exist. See the block in `castFor`.
   *
   * Mutated from the console (`window.collisionWorld.ignore.wmo = true`) and nowhere in the code, so
   * a shipped build behaves exactly as it did -- all three false.
   */
  readonly ignore = { terrain: false, wmo: false, doodads: false };

  /**
   * **THE PUSH-OUT, AND THE COUNTER THAT SAYS WHETHER IT RAN.**
   *
   * Two things at once, because the owner reported "не получается переступить даже маленькую
   * ступеньку" right after the push-out landed and neither of us knows whether it is the cause. A
   * flag alone would only let him A/B a feel, which is the weakest evidence this project accepts;
   * the counters make the question answerable without a second run:
   *
   *  - `fired` zero at a step he could not climb ACQUITS the push-out entirely -- the recovery never
   *    ran, so whatever stopped him is the step-up or the slide, and this commit is not in the story;
   *  - `fired` climbing with `freed` climbing means it is running AND moving him every frame, which
   *    is exactly the shape of "pushed back off the tread as fast as he climbs it";
   *  - `fired` climbing with `freed` zero means it runs, finds no overlap, and costs a gather per
   *    stuck frame for nothing -- a performance answer rather than a correctness one.
   *
   * `enabled = false` is the bisection: it restores the pre-push-out mover exactly, since the caller
   * treats a null return and an absent closure the same way.
   *
   * Console-only, like `ignore`. Two integer increments on a path that already gathers triangles.
   */
  readonly pushOut = {
    enabled: true,
    fired: 0,
    freed: 0,
    /**
     * **THE MOST RECENT OVERLAP, NAMED -- and it is NOT the one a frozen trace caught.** A previous
     * commit of mine claimed it was, and that was wrong: the real push-out runs on every grounded
     * frame regardless of the trace, so these fields keep being overwritten after a trap freezes.
     * The owner read `lastSource: null` for exactly that reason -- by then he was free.
     *
     * Good for a live glance; for anything a trap caught, read the frame's own
     * `penetrationSource` instead.
     */
    lastSource: null as string | null,
    lastNormalZ: 0,
    lastGap: 0,
  };

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
      /**
     * **THE PAD IS THE CAPSULE, AND NOTHING MORE. The `+ 0.5` was undocumented slack and it cost
     * three times the candidates.**
     *
     * A capsule anywhere along the sweep occupies `radius` in X and Y and `radius + halfSegment` in Z,
     * so padding the swept segment by `radius + halfSegment` on every axis already CONTAINS it -- and
     * over-contains it horizontally by `halfSegment`. The extra half yard was pure margin.
     *
     * It is worth removing because it cuts the candidate count, and the box volume falls as the cube
     * of the pad: `(1.01 / 1.51)^3` is 0.30. That much stands.
     *
     * **BUT THE COST MODEL THIS NOTE USED TO ASSERT WAS WRONG, and the correction matters more than
     * the pad.** It said "the candidate count is the whole cost of a cast", and reasoned: on the
     * abbey stairs a cast gathered 249-336 WMO triangles, a frame issues about ten casts, so ~3000
     * capsule-triangle solves a frame "which is `ctl.move` at 3.8 ms almost exactly". That is ~1.3 us
     * per solve, and it is REFUTED by measurement:
     *
     *  - the owner's `window.castCensus()` on open ground: **69 candidates per frame** over 3 casts
     *    and 1 push-out -- and `ctl.move` still **4.7 ms**. Forty times fewer candidates for the same
     *    cost, so the two cannot both be linear in candidates.
     *  - `__bench__/gather.test.ts` prices the part that is not: `TerrainProvider.gather` against a
     *    box overlapping ONE chunk, returning an identical 4 candidates either way, costs **10.6 us
     *    with 1 chunk registered and 539.6 us with 64** -- about **8.4 us per registered chunk the
     *    query does not touch**.
     *
     * So a cast's cost is NOT linear in candidates. What it is instead was then measured live and is
     * **not** the gather either: the owner's A/B put `gatherUs` at ~100 us over 4 gathers a frame,
     * i.e. **0.4 ms of a 4.6 ms `ctl.move`**, with disabling the chunk rejection making no difference.
     * An intermediate version of this note blamed the per-chunk matrix inversion and derived ~2.7 ms
     * from an offline bench; that extrapolation was unsound and is withdrawn. Roughly 90% of the
     * mover is elsewhere, and `movement/move-phases.ts` is the instrument built to say where.
     *
     * The 3.8 ms abbey-stairs number was real; the ATTRIBUTION was not. Its ~3000 solves and its
     * chunk count moved together, so a per-chunk cost read as a per-candidate one.
     *
     * STRICTLY CONSERVATIVE, which is the only reason it is safe: the box still contains every point
     * the capsule can occupy on this sweep, so no triangle that could be hit is dropped. Nothing about
     * which triangles BLOCK changes -- only how many are examined.
     */
      const pad = radius + halfSegment;
      _box.min.subScalar(pad);
      _box.max.addScalar(pad);

      /**
       * PER-PROVIDER NOCLIP. `collisionWorld.ignore.wmo = true` and a building stops existing.
       *
       * The owner asked for it while stuck inside geometry -- "а то я не выберусь из текстуры" -- and
       * PER PROVIDER is the point rather than one global switch: ignoring everything makes the ground
       * vanish too, and a body with no floor falls until `rescueFromVoid` catches it, which is a
       * second problem on top of the first. Ignoring the WMO alone leaves the terrain holding him up
       * while he walks out through the wall.
       *
       * IT IS ALSO A BISECTION, and that is why it is worth having beyond the rescue: "does the
       * sticking stop when the WMO is ignored" separates a building defect from a terrain or doodad
       * one in one gesture, with no rebuild and no new probe.
       *
       * Three boolean reads per cast when unused, which is nothing beside the gathers they guard.
       */
      if (!this.ignore.terrain) {
        this.terrain.gather(_box, candidates);
      }
      const afterTerrain = candidates.length;
      if (!this.ignore.wmo) {
        this.wmo.gather(_box, layer, candidates);
      }
      const afterWmo = candidates.length;
      if (!this.ignore.doodads) {
        this.doodads.gather(_box, candidates);
      }

      // THE CENSUS, on numbers this path already computed. Four integer adds; see `castCensus`.
      castCensus.casts += 1;
      castCensus.castTerrain += afterTerrain;
      castCensus.castWmo += afterWmo - afterTerrain;
      castCensus.castDoodads += candidates.length - afterWmo;

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

  /**
   * A PUSH-OUT closure for one audience and one capsule shape: the recovery a sweep cannot perform.
   *
   * A sweep answers "what would I hit going that way". A body already INSIDE geometry is blocked every
   * way at distance zero, which is the state the owner reached under the abbey stairs -- four slide
   * iterations, all `travelled: 0`, all against downward-facing faces. Only a positional correction
   * gets out, and that needs the candidate SET rather than a cast.
   *
   * THE BOX IS THE CAPSULE ITSELF, padded by the skin and no more. Unlike a cast there is no sweep to
   * cover, so this is the smallest honest query -- and it matters, because the caller runs this only
   * when stuck and wants the answer to be about where the body IS.
   */
  depenetrateFor(
    layer: CollisionLayer,
    radius: number,
    halfSegment: number,
    /** The walk election's own cosine -- see `depenetrateCapsule`'s `restingCos`. */
    restingCos = 1.1,
  ) {
    /**
     * `count` false for a MEASURE-ONLY call. The movement trace asks for the overlap depth every
     * frame it records, and a measurement that moved `fired`/`freed` would be one instrument
     * corrupting another -- those two counters are how the recovery itself is diagnosed, and I have
     * been reading them all round.
     */
    return (
      center: THREE.Vector3,
      skin = 0,
      count = true,
      /**
       * The caller's own report slot. **`pushOut.lastSource` below is NOT usable for a frozen
       * trace and my previous commit message said it was -- that claim was false.** The real
       * push-out runs every grounded frame whether or not the trace is recording, so it overwrites
       * those fields long after a trap has frozen; what the console reads is the latest frame, by
       * which time the body is free. Only a value copied into the trace FRAME survives the freeze.
       */
      infoOut?: { source: string | null; normalZ: number; gap: number },
      /** The centre at the start of the frame -- see `depenetrateCapsule`'s `cameFrom`. */
      cameFrom?: THREE.Vector3,
    ): THREE.Vector3 | null => {
      // Before the gather, so a disabled push-out costs one boolean and the caller sees exactly what
      // it saw before this feature existed.
      if (!this.pushOut.enabled) {
        return null;
      }
      if (count) {
        this.pushOut.fired += 1;
      }

      const candidates = this.candidates;
      candidates.length = 0;

      _box.makeEmpty().expandByPoint(center);
      const pad = radius + halfSegment + skin;
      _box.min.subScalar(pad);
      _box.max.addScalar(pad);

      if (!this.ignore.terrain) {
        this.terrain.gather(_box, candidates);
      }
      const pushAfterTerrain = candidates.length;
      if (!this.ignore.wmo) {
        this.wmo.gather(_box, layer, candidates);
      }
      const pushAfterWmo = candidates.length;
      if (!this.ignore.doodads) {
        this.doodads.gather(_box, candidates);
      }
      // THE CENSUS for the push-out's OWN gather -- a different box from the swept cast's, and at
      // rest one of only three cast-equivalents the mover runs. See `castCensus`.
      castCensus.pushOuts += 1;
      castCensus.pushTerrain += pushAfterTerrain;
      castCensus.pushWmo += pushAfterWmo - pushAfterTerrain;
      castCensus.pushDoodads += candidates.length - pushAfterWmo;

      _penInfo.source = null;
      _penInfo.normalZ = 0;
      _penInfo.gap = 0;
      /**
       * The DEADBAND is the skin, for the recovery, and stays at the epsilon for a measure-only
       * call -- so the trace keeps reporting the true overlap while the recovery ignores tangency.
       * The two answering differently is deliberate: an instrument that adopted the deadband could
       * not show what the deadband is doing.
       */
      const deadband = count ? Math.max(skin, CAPSULE_CAST_EPS) : CAPSULE_CAST_EPS;
      const freed = depenetrateCapsule(
        center, radius, halfSegment, candidates, skin, 4, _penInfo, deadband, cameFrom,
        restingCos,
      );
      const described = _penInfo.source === null ? null : describeSource(_penInfo.source);
      this.pushOut.lastSource = described;
      this.pushOut.lastNormalZ = _penInfo.normalZ;
      this.pushOut.lastGap = _penInfo.gap;
      if (infoOut) {
        infoOut.source = described;
        infoOut.normalZ = _penInfo.normalZ;
        infoOut.gap = _penInfo.gap;
      }
      if (freed !== null && count) {
        this.pushOut.freed += 1;
      }
      return freed;
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
  // The candidate census -- guarded like everything else here, because the movement and collision
  // suites import this module in a node environment where `window` does not exist. Ten suites went
  // red on a module-scope assignment before this was moved inside.
  (window as any).castCensus = readCastCensus;
  // The A/B readout. Guarded with the rest: the collision and movement suites import this module
  // under node, where `window` does not exist -- a module-scope assignment took ten suites red once
  // already this session.
  (window as any).moveProfile = readMoveProfile;
  (window as any).moveProfileReset = resetMoveProfile;
  (window as any).castCensusReset = resetCastCensus;
  // Reachable from the console: "is there any collision geometry near me, and from which provider"
  // is the first question every movement or camera report asks, and it is not answerable from the
  // scene graph -- collision comes from the BSP and the heightmap, not from what is drawn.
  (window as any).collisionWorld = collisionWorld;
  // The per-provider cast trace -- see the block in `castFor`. Off by default.
  (window as any).castTrace = castTrace;
}
