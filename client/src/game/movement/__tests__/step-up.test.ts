/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import { CAPSULE_HEIGHT, GROUND_COS, STEP_UP_HEIGHT } from '../constants';
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
    const out = stepUp(scriptedCast({ ahead: null }), v3(0, 0, 0), FWD, 0.12);

    expect(out.landed).toBeNull();
    expect(out.verdict).toBe('no-obstacle');
  });

  it('leaves a walkable slope to the plain slide', () => {
    const walkable = v3(-0.3, 0, 0.954).normalize(); // ~17 degrees
    expect(walkable.z).toBeGreaterThan(GROUND_COS);

    const out = stepUp(scriptedCast({ ahead: hit(0.05, walkable) }), v3(0, 0, 0), FWD, 0.12);

    expect(out.verdict).toBe('no-obstacle');
  });

  it('leaves an overhang alone', () => {
    const overhang = v3(-0.5, 0, -0.7).normalize();
    const out = stepUp(scriptedCast({ ahead: hit(0.05, overhang) }), v3(0, 0, 0), FWD, 0.12);

    expect(out.verdict).toBe('no-obstacle');
  });

  it('leaves a receding face alone', () => {
    // A face whose normal points the same way we are travelling opposes nothing.
    const receding = v3(Math.sin(1.2), 0, Math.cos(1.2)).normalize();
    const out = stepUp(scriptedCast({ ahead: hit(0.05, receding) }), v3(0, 0, 0), FWD, 0.12);

    expect(out.verdict).toBe('no-obstacle');
  });

  it('commits onto the top of a low step', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()),
      up: null,                              // full STEP_UP_HEIGHT of headroom
      forward: null,                         // the full travel is clear at the raised height
      down: hit(STEP_UP_HEIGHT - 0.3, UP),   // floor 0.3 above where we started
    }), v3(0, 0, 0), FWD, 0.12);

    expect(out.verdict).toBe('commit');
    expect(out.landed).not.toBeNull();
    expect(out.climb).toBeCloseTo(0.3, 5);
    expect(out.landed!.z).toBeCloseTo(0.3, 5);
    expect(out.landed!.x).toBeCloseTo(0.12, 5);
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
    }), v3(0, 0, 0), FWD, 0.12);

    expect(out.verdict).toBe('no-descent');
    expect(out.landed).toBeNull();
    expect(out.climb).toBe(0);
  });

  it('slides instead when there is no headroom above', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()),
      up: hit(0.0005, v3(0, 0, -1)), // a ceiling immediately overhead
    }), v3(0, 0, 0), FWD, 0.12);

    expect(out.landed).toBeNull();
    expect(out.verdict).toBe('no-headroom');
  });

  it('slides instead when there is no floor under the advanced point', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()), up: null, forward: null, down: null,
    }), v3(0, 0, 0), FWD, 0.12);

    expect(out.landed).toBeNull();
    expect(out.verdict).toBe('no-floor');
  });

  it('never commits onto a steep landing -- this is why the tree pinch cannot wedge', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()), up: null, forward: null,
      down: hit(0.2, steepFace()),
    }), v3(0, 0, 0), FWD, 0.12);

    expect(out.landed).toBeNull();
    expect(out.verdict).toBe('steep-floor');
  });

  it('nets a grazing rub back onto the same floor, which reads as sliding', () => {
    // The settle lands exactly where we rose from: no height gained, so no commit. Committing here
    // would dead-stop what should read as sliding along the face.
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()), up: null, forward: null,
      down: hit(STEP_UP_HEIGHT, UP),
    }), v3(0, 0, 0), FWD, 0.12);

    expect(out.landed).toBeNull();
    expect(out.verdict).toBe('net-zero');
  });

  it('slides off a wall taller than the ceiling, which leaves no forward clearance', () => {
    const out = stepUp(scriptedCast({
      ahead: hit(0.05, steepFace()), up: null,
      forward: hit(0, steepFace()),   // still blocked at the raised height
      down: hit(STEP_UP_HEIGHT, UP),  // settles back on the origin floor
    }), v3(0, 0, 0), FWD, 0.12);

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
    }), v3(0, 0, 0), FWD, 0.12);

    expect(out.verdict).toBe('commit');
    expect(out.climb).toBeCloseTo(STEP_UP_HEIGHT - 0.01, 5);
  });

  it('advances this frame travel, not a probe-length lunge', () => {
    // A committed step must move us by the distance we were actually going to travel. Using the
    // probe length instead would teleport a slow walker onto a step.
    const travel = 0.03;
    const out = stepUp(scriptedCast({
      ahead: hit(0.01, steepFace()), up: null, forward: null,
      down: hit(STEP_UP_HEIGHT - 0.2, UP),
    }), v3(0, 0, 0), FWD, travel);

    expect(out.verdict).toBe('commit');
    expect(out.landed!.x).toBeCloseTo(travel, 6);
  });

  it('is bounded well below the capsule height, so fences slide', () => {
    expect(STEP_UP_HEIGHT).toBeLessThan(CAPSULE_HEIGHT / 2);
  });
});
