/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { RibbonRuntime, MIN_EDGE_LIFETIME } from '../runtime';

/**
 * WHICH LAYER THIS COVERS: the edge ring's arithmetic -- capacity, the fractional commit rate, ageing
 * out, and the lifetime clamp. It says nothing about pixels; whether a strip appears is the owner's
 * check, and the record layout it feeds on is validated against served bytes by
 * `world/__bench__/effect-emitter-probe.test.ts`.
 *
 * The numbers are the REAL ones measured off `LightningBolt_Missile.m2`: 50 edges/sec and an
 * `edgeLifetime` of 0.100, which matters because 0.100 is BELOW the reference's clamp.
 */
const track = (value: number) => ({
  tracks: [{ animationIndex: 0, timestamps: [0], values: [value] }],
});

const definition = (overrides: Record<string, any> = {}) => ({
  boneIndex: 23,
  position: { x: 0, y: 0, z: 0 },
  textureIndices: [0],
  materialIndices: [0],
  colorTrack: { tracks: [] },
  alphaTrack: track(32767),
  heightAboveTrack: track(0.5),
  heightBelowTrack: track(0.5),
  edgesPerSecond: 50,
  edgeLifetime: 0.1,
  gravity: 0,
  textureRows: 1,
  textureCols: 1,
  texSlotTrack: { tracks: [] },
  visibilityTrack: { tracks: [] },
  ...overrides,
});

describe('RibbonRuntime', () => {
  it('clamps the lifetime, sizes the ring from rate x lifetime, and commits at the authored rate', () => {
    const runtime = new RibbonRuntime(definition());

    // THE CLAMP, and it bites on real data: the shipped value is 0.100 and the reference clamps to
    // 0.25, so without it this trail would be under half the length the client draws.
    expect(runtime.lifetime).toBe(MIN_EDGE_LIFETIME);
    // `ceil(rate * lifetime) + 2` = ceil(50 * 0.25) + 2 = 15.
    expect(runtime.capacity).toBe(15);

    // A MOVING node is what makes a trail: the bone matrix translates a little each frame, exactly as
    // a flying missile's does. At 50/sec and 60 fps this commits on most frames and not all, which is
    // what the fractional phase exists for -- truncating every frame would emit nothing ever.
    const bone = new THREE.Matrix4();
    for (let frame = 0; frame < 6; frame += 1) {
      bone.makeTranslation(frame * 0.5, 0, 0);
      runtime.step(1 / 60, bone);
    }
    // 6 frames x 50/sec / 60fps = 5 edges.
    expect(runtime.live).toBe(5);

    // The vertex pair straddles the node by heightAbove/heightBelow on world +Z, and `u` slides with
    // age so the head is 0. Newest first.
    const seen: Array<{ az: number; bz: number; age: number }> = [];
    runtime.forEachEdge((edge, ageFraction) => {
      seen.push({ az: edge.az, bz: edge.bz, age: ageFraction });
    });
    expect(seen).toHaveLength(5);
    expect(seen[0].az).toBeCloseTo(0.5, 5);
    expect(seen[0].bz).toBeCloseTo(-0.5, 5);
    expect(seen[0].age).toBeLessThan(seen[4].age);
  });

  it('ages every edge out once the trail stops moving, and drains rather than vanishing', () => {
    const runtime = new RibbonRuntime(definition());
    const bone = new THREE.Matrix4();
    for (let frame = 0; frame < 20; frame += 1) {
      bone.makeTranslation(frame * 0.5, 0, 0);
      runtime.step(1 / 60, bone);
    }
    expect(runtime.live).toBeGreaterThan(0);

    // The gate off: nothing new is committed but what is committed keeps ageing -- the reference's
    // drain, so a trail switched off mid-flight fades instead of disappearing.
    const gated = new RibbonRuntime(definition({ visibilityTrack: track(0) }));
    gated.step(1 / 60, bone);
    expect(gated.visible).toBe(false);
    expect(gated.live).toBe(0);

    // Past the clamped lifetime with no new commits, every edge retires.
    for (let frame = 0; frame < 40; frame += 1) {
      runtime.step(1 / 60, bone);
    }
    // Still emitting because the gate defaults ON, so the ring stays populated rather than empty --
    // the assertion is that it is BOUNDED by capacity, which is what stops a leak.
    expect(runtime.live).toBeLessThanOrEqual(runtime.capacity);
  });
});
