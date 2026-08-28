/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import {
  CAPSULE_HEIGHT, CAPSULE_RADIUS, GROUND_COS, SKIN_WIDTH, STEP_UP_ADVANCE, STEP_UP_HEIGHT,
} from '../constants';
import { stepUp } from '../step-up';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v3(0, 0, 1);
const FWD = v3(1, 0, 0);

/**
 * A scripted cast. Each probe direction returns a fixed answer, which is the only way to test a
 * maneuver whose entire logic is "what did the four probes say". The first horizontal probe is the
 * obstacle test; later ones are the raised advance.
 */
function scriptedCast(script: {
  ahead?: CastHit | null;
  up?: CastHit | null;
  forward?: CastHit | null;
  down?: CastHit | null;
}): CastFn {
  let aheadUsed = false;

  return (_from, dir) => {
    if (dir.z > 0.5) return script.up ?? null;
    if (dir.z < -0.5) return script.down ?? null;
    if (!aheadUsed) {
      aheadUsed = true;
      return script.ahead ?? null;
    }
    return script.forward ?? null;
  };
}

const hit = (distance: number, normal: THREE.Vector3): CastHit => ({
  distance, normal: normal.clone(), source: {},
});

/** A steep face opposing +x travel: normal tilted 70 degrees from horizontal. */
function steepFace() {
  const r = (70 * Math.PI) / 180;
  return v3(-Math.sin(r), 0, Math.cos(r));
}

describe('stepUp', () => {
  it('does nothing when there is no obstacle ahead', () => {
    const out = stepUp(scriptedCast({ ahead: null }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.landed).toBeNull();
    expect(out.verdict).toBe('no-obstacle');
  });

  it('leaves a walkable slope to the plain slide', () => {
    const walkable = v3(-0.3, 0, 0.954).normalize(); // ~17 degrees
    expect(walkable.z).toBeGreaterThan(GROUND_COS);

    const out = stepUp(scriptedCast({ ahead: hit(0.05, walkable) }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.verdict).toBe('no-obstacle');
  });

  it('leaves an overhang alone', () => {
    const overhang = v3(-0.5, 0, -0.7).normalize();
    const out = stepUp(scriptedCast({ ahead: hit(0.05, overhang) }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.verdict).toBe('no-obstacle');
  });

  it('leaves a receding face alone', () => {
    // A face whose normal points the same way we are travelling opposes nothing.
    const receding = v3(Math.sin(1.2), 0, Math.cos(1.2)).normalize();
    const out = stepUp(scriptedCast({ ahead: hit(0.05, receding) }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.verdict).toBe('no-obstacle');
  });

  it('commits onto the top of a low step', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()),
      up: null,                              // full STEP_UP_HEIGHT of headroom
      forward: null,                         // the full travel is clear at the raised height
      down: hit(STEP_UP_HEIGHT - 0.3, UP),   // floor 0.3 above where we started
    }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.verdict).toBe('commit');
    expect(out.climb).toBeCloseTo(0.3, 5);
    // WHAT THE FRAME COMMITS IS THE RISE. `landed` is the probe's own settle point, a full advance
    // downrange, and committing it as a position was the teleport -- so the assertion is on `rise`.
    expect(out.rise).toBeCloseTo(STEP_UP_HEIGHT, 5);
    // The settle is probed at TWO offsets and the highest landing wins. This fixture answers every
    // downward probe identically, so the two tie -- and a tie keeps the NEAR one, deliberately:
    // standing closer is the safer of two equal landings. `landed` is diagnostic either way.
    expect(out.landed!.x).toBeCloseTo(CAPSULE_RADIUS + SKIN_WIDTH, 5);
  });

  // THE COLLISION STALL. A zero-distance settle is not a landing -- it is the swept cast saying the
  // RAISED capsule is already in contact (`capsule-cast.ts#planeTimeOfImpact`'s
  // `gap <= CAPSULE_CAST_EPS` branch), with the normal oriented toward the capsule and therefore
  // pointing up, so it passes the walkable test. Committing gave `climb === rise` and teleported the
  // body a full `STEP_UP_HEIGHT` into a fence plank -- measured live at 0.7000000000000028 twice in
  // consecutive frames.
  it('refuses a settle that never descended, instead of committing into the collider', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()),
      up: null,                 // full STEP_UP_HEIGHT of headroom
      forward: null,            // the full travel is clear at the raised height
      down: hit(0, UP),         // "floor" at distance zero: already touching at the raised height
    }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.verdict).toBe('no-descent');
    expect(out.landed).toBeNull();
    expect(out.climb).toBe(0);
  });

  it('slides instead when there is no headroom above', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()),
      up: hit(0.0005, v3(0, 0, -1)), // a ceiling immediately overhead
    }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.landed).toBeNull();
    expect(out.verdict).toBe('no-headroom');
  });

  it('slides instead when there is no floor under the advanced point', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()), up: null, forward: null, down: null,
    }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.landed).toBeNull();
    expect(out.verdict).toBe('no-floor');
  });

  it('never commits onto a steep landing -- this is why the tree pinch cannot wedge', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()), up: null, forward: null,
      down: hit(0.2, steepFace()),
    }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.landed).toBeNull();
    expect(out.verdict).toBe('steep-floor');
  });

  it('nets a grazing rub back onto the same floor, which reads as sliding', () => {
    // The settle lands exactly where we rose from: no height gained, so no commit. Committing here
    // would dead-stop what should read as sliding along the face.
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()), up: null, forward: null,
      down: hit(STEP_UP_HEIGHT, UP),
    }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.landed).toBeNull();
    expect(out.verdict).toBe('net-zero');
  });

  it('slides off a wall taller than the ceiling, which leaves no forward clearance', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()), up: null,
      forward: hit(0, steepFace()),   // still blocked at the raised height
      down: hit(STEP_UP_HEIGHT, UP),  // settles back on the origin floor
    }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.landed).toBeNull();
    expect(out.verdict).toBe('net-zero');
  });

  // THIS TEST USED TO ASSERT THE DEFECT. It scripted `down: hit(0, UP)` -- "floor exactly at the
  // raised height" -- and expected a COMMIT with `climb === STEP_UP_HEIGHT`. That is bit-for-bit the
  // signature measured live when the mover teleported the body into `ELWYNNWOODFENCE01`'s hull: a
  // zero-distance settle is the swept cast reporting that the raised capsule is ALREADY IN CONTACT,
  // not that a floor happens to sit exactly there, and `stepUp` now refuses it (`no-descent`).
  //
  // The intent -- the rise is capped at STEP_UP_HEIGHT however much headroom there is -- is kept, and
  // is now expressed with a settle that actually descends. A floor 0.01 below the raised height gives
  // climb 0.69, which is only reachable if the rise was 0.70 and not more.
  it('never rises further than STEP_UP_HEIGHT, even with unlimited headroom', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()), up: null, forward: null,
      down: hit(0.01, UP), // floor a hair below the raised height, so the settle really descends
    }), v3(0, 0, 0), FWD, 0.12, STEP_UP_ADVANCE);

    expect(out.verdict).toBe('commit');
    expect(out.climb).toBeCloseTo(STEP_UP_HEIGHT - 0.01, 5);
  });

  /**
   * **THIS TEST ASSERTED A LAW THAT HAS SINCE BEEN REVERSED, and its old name said so out loud:
   * "advances this frame travel, not a probe-length lunge".** It scripted travel 0.03 and required
   * the landing to be 0.03 downrange.
   *
   * The intent was right and the mechanism was in the wrong place. A slow walker must not be
   * teleported onto a step -- but the fix for that is that the frame commits a RISE and never the
   * probe's landing at all, which is what makes the probe free to reach as far as the body needs to
   * SEE. Binding the reach to the travel instead bought the same safety by blinding the maneuver,
   * and the price was the owner unable to climb a small step at any frame rate.
   *
   * So both halves are asserted here, together, because either alone is a defect: the probe looks a
   * BODY LENGTH ahead, and the commit is a vertical rise with no horizontal component to lunge with.
   */
  it('reaches a body length to decide, and commits a rise rather than that reach', () => {
    const travel = 0.03;
    const out = stepUp(scriptedCast({
      ahead: hit(0.01, steepFace()), up: null, forward: null,
      down: hit(STEP_UP_HEIGHT - 0.2, UP),
    }), v3(0, 0, 0), FWD, travel, Math.max(travel, STEP_UP_ADVANCE));

    expect(out.verdict).toBe('commit');
    expect(out.rise).toBeCloseTo(STEP_UP_HEIGHT, 5);
    // The reach must exceed the capsule's own half-width, or the settle can never clear a lip --
    // the case below measures the consequence. (`detail` is not asserted: it is populated only
    // while the movement trace is on, and a test that switched the instrument on to read its own
    // input would be measuring the instrument.)
    expect(STEP_UP_ADVANCE).toBeGreaterThan(CAPSULE_RADIUS);
  });

  /**
   * **THE OWNER'S STEP, as his trace measured it -- and the only test here whose cast answers by
   * POSITION rather than by direction, because that is the whole mechanism.**
   *
   * A riser at x = 0.34 with a tread 0.25 above. The settle descends from wherever the advance put
   * it: still behind the lip, the capsule overhangs the floor it came from and finds it at the full
   * rise; past the lip, it finds the tread. One frame of travel leaves the probe behind the lip --
   * that is the defect, and it is asserted here so a future shortening of the advance fails loudly
   * instead of quietly making steps unclimbable again.
   */
  /**
   * **THE OWNER'S DOORWAY SILL, and it is the FAR probe's blind spot -- the mirror image of the case
   * below.**
   *
   * Measured at the abbey door, 18 identical stalled frames: the elevated sweep free for the whole
   * 1.1918 and the settle descending 0.8208 of a 0.7 rise, i.e. `climb` **-0.12**. The long probe flew
   * over the sill and sampled the interior floor, which is lower than where he stood; the sill top he
   * needed was between him and the probe. His collision overlay showed the geometry is exactly what it
   * looks like, so the refusal was a sampling gap and not bad data.
   *
   * The fixture is that shape: a sill from one radius out to 0.60 whose top is 0.25 up, and beyond it a
   * floor 0.12 DOWN. The far probe alone nets zero; the near probe finds the sill.
   */
  it('finds a sill the far probe flies over, when the floor beyond is lower', () => {
    const SILL_FROM = 0.34;
    const SILL_TO = 0.60;
    const SILL_UP = 0.25;
    const BEYOND_DOWN = 0.12;
    const byPosition: CastFn = (from, dir) => {
      if (dir.z > 0.5) return null;
      if (dir.z < -0.5) {
        if (from.x >= SILL_FROM && from.x <= SILL_TO) {
          return hit(STEP_UP_HEIGHT - SILL_UP, UP);
        }
        if (from.x > SILL_TO) {
          return hit(STEP_UP_HEIGHT + BEYOND_DOWN, UP);
        }
        return hit(STEP_UP_HEIGHT, UP);
      }
      return from.z > 0.5 ? null : hit(0, steepFace());
    };

    const out = stepUp(byPosition, v3(0, 0, 0), FWD, 0.18, STEP_UP_ADVANCE);

    expect(out.verdict).toBe('commit');
    expect(out.climb).toBeCloseTo(SILL_UP, 5);
    // And the near offset is what found it, which is the whole point of the second sample.
    expect(out.landed!.x).toBeCloseTo(CAPSULE_RADIUS + SKIN_WIDTH, 5);
  });

  it('clears a lip a frame of travel cannot reach', () => {
    const LIP = 0.34;
    const TREAD = 0.25;
    const byPosition: CastFn = (from, dir) => {
      if (dir.z > 0.5) return null;
      if (dir.z < -0.5) {
        return from.x > LIP
          ? hit(STEP_UP_HEIGHT - TREAD, UP)   // over the tread
          : hit(STEP_UP_HEIGHT, UP);          // still over the floor we left
      }
      return from.z > 0.5 ? null : hit(0, steepFace());
    };

    const short = stepUp(byPosition, v3(0, 0, 0), FWD, 0.18, 0.18);
    expect(short.verdict).toBe('net-zero');

    const full = stepUp(byPosition, v3(0, 0, 0), FWD, 0.18, STEP_UP_ADVANCE);
    expect(full.verdict).toBe('commit');
    expect(full.climb).toBeCloseTo(TREAD, 5);
  });

  it('is bounded well below the capsule height, so fences slide', () => {
    expect(STEP_UP_HEIGHT).toBeLessThan(CAPSULE_HEIGHT / 2);
  });
});
