/**
 * @jest-environment node
 */
import * as THREE from 'three';
import { AreaLight } from '../types';
import { selectLightsForPosition } from '../utils';

// Minimal AreaLight fixture -- selectLightsForPosition only reads position/falloffStart/falloffEnd,
// never `params`, so params is left empty here.
const mkLight = (x: number, y: number, z: number, falloffStart: number, falloffEnd: number): AreaLight => ({
  id: 0,
  mapId: 0,
  position: new THREE.Vector3(x, y, z),
  falloffStart,
  falloffEnd,
  params: [],
});

// A map-wide default light: no falloff, so it is identified by falloffEnd === 0 alone (position no
// longer matters -- see utils.ts's doc for why the old MAP_CORNER position check was too strict).
const mkDefault = (id: number, x = 0, y = 0, z = 0): AreaLight => ({
  id,
  mapId: 0,
  position: new THREE.Vector3(x, y, z),
  falloffStart: 0,
  falloffEnd: 0,
  params: [],
});

const sumWeights = (weights: Array<{ weight: number }>) =>
  weights.reduce((sum, w) => sum + w.weight, 0);

describe('selectLightsForPosition weight seeding', () => {
  it('identifies a default light by falloffEnd === 0 alone, regardless of its position', () => {
    // Not at the map corner -- this is exactly the map-571 shape: a real falloffEnd === 0 record that
    // the old position-gated check rejected, resolving zero area lights.
    const local = mkLight(75, 0, 0, 50, 100); // distance 75 -> raw weight 0.5
    const def = mkDefault(99, 12345, -6789, 42);

    const selected = selectLightsForPosition([local, def], new THREE.Vector3(0, 0, 0));

    expect(selected).toHaveLength(2);
    expect(sumWeights(selected)).toBeCloseTo(1, 6);

    const defaultEntry = selected.find((s) => s.light.id === 99)!;
    const localEntry = selected.find((s) => s.light.id !== 99)!;
    expect(localEntry.weight).toBeCloseTo(0.5, 6);
    // The default absorbs exactly what the local light left unclaimed.
    expect(defaultEntry.weight).toBeCloseTo(0.5, 6);
  });

  it('a single local light plus a default light keeps varying continuously with distance -- the regression', () => {
    // Before the fix, normalising a single selected light always drove it to weight 1 regardless of
    // distance. With a default light present, the local light's own weight must still track its raw
    // falloff share, and the default must absorb the complement.
    const near = mkLight(60, 0, 0, 50, 100); // distance 60 -> falloff 0.2 -> raw weight 0.8
    const far = mkLight(90, 0, 0, 50, 100); // distance 90 -> falloff 0.8 -> raw weight 0.2
    const def = mkDefault(1);

    const nearSelected = selectLightsForPosition([near, def], new THREE.Vector3(0, 0, 0));
    const farSelected = selectLightsForPosition([far, def], new THREE.Vector3(0, 0, 0));

    const nearLocal = nearSelected.find((s) => s.light === near)!;
    const farLocal = farSelected.find((s) => s.light === far)!;

    expect(nearLocal.weight).toBeCloseTo(0.8, 6);
    expect(farLocal.weight).toBeCloseTo(0.2, 6);
    expect(nearLocal.weight).not.toBeCloseTo(farLocal.weight, 3);
  });

  it('hands the leftover to the nearest in-range light when the map has no default record', () => {
    // Neither light is a falloffEnd === 0 record -- this is the Warsong Gulch (map 489) shape.
    const closer = mkLight(85, 0, 0, 50, 100); // distance 85 -> falloff 0.7 -> raw weight 0.3
    const farther = mkLight(0, 90, 0, 50, 100); // distance 90 -> falloff 0.8 -> raw weight 0.2

    const selected = selectLightsForPosition([closer, farther], new THREE.Vector3(0, 0, 0));

    expect(selected).toHaveLength(2);
    expect(sumWeights(selected)).toBeCloseTo(1, 6);

    // Raw shares were 0.3 and 0.2; the 0.5 shortfall goes entirely to the nearer light (0.3 + 0.5),
    // not spread proportionally -- normalising away the shortfall is exactly the regression.
    const closerEntry = selected.find((s) => s.light === closer)!;
    const fartherEntry = selected.find((s) => s.light === farther)!;
    expect(closerEntry.weight).toBeCloseTo(0.8, 6);
    expect(fartherEntry.weight).toBeCloseTo(0.2, 6);
  });

  it('falls back to the nearest record overall when nothing is in range and there is no default', () => {
    // Every light is farther than its own falloffEnd from the camera, so nothing would be selected by
    // range alone -- this used to resolve to an empty array, which made MapLight#updateLights freeze
    // the previous frame's colours rather than resolving anything.
    const light = mkLight(1000, 0, 0, 50, 100);
    const selected = selectLightsForPosition([light], new THREE.Vector3(0, 0, 0));

    expect(selected).toHaveLength(1);
    expect(selected[0].light).toBe(light);
    expect(selected[0].weight).toBeCloseTo(1, 6);
  });

  it('returns an empty array when there are no light records for the map at all', () => {
    const selected = selectLightsForPosition([], new THREE.Vector3(0, 0, 0));
    expect(selected).toEqual([]);
  });

  it('does not divide by zero when the only selected light has zero raw weight', () => {
    // Sitting exactly on the falloffEnd boundary: falloff == 1, so the raw weight is exactly 0. No
    // default and nothing else on the map, so the full leftover still lands on this light.
    const light = mkLight(100, 0, 0, 50, 100);
    const selected = selectLightsForPosition([light], new THREE.Vector3(0, 0, 0));

    expect(selected).toHaveLength(1);
    expect(Number.isNaN(selected[0].weight)).toBe(false);
    expect(selected[0].weight).toBeCloseTo(1, 6);
  });

  it('never produces NaN weights, even with an empty light list', () => {
    const selected = selectLightsForPosition([], new THREE.Vector3(0, 0, 0));
    expect(selected.every((s) => !Number.isNaN(s.weight))).toBe(true);
  });
});

describe('selectLightsForPosition smoothness', () => {
  it('changes a light\'s resolved weight monotonically and continuously across its falloff band', () => {
    // Walk the camera from just inside falloffStart to just past falloffEnd in small steps, along with
    // a default light to absorb the complement (the realistic, fixed shape). The regression this test
    // exists for: normalising drove the local weight to a flat 1.0 for every step, which is neither
    // monotonic movement nor a plain constant -- it hid the ramp entirely. A merely-sums-to-1 test
    // cannot tell that apart from the fix; only sampling adjacent steps can.
    const falloffStart = 50;
    const falloffEnd = 150;
    const light = mkLight(0, 0, 0, falloffStart, falloffEnd);
    const def = mkDefault(1);

    const steps = 40;
    const epsilon = 1 / steps + 0.01; // no single step may move the weight by more than this

    const weights: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const distance = falloffStart + (i / steps) * (falloffEnd - falloffStart);
      const position = new THREE.Vector3(distance, 0, 0);
      const selected = selectLightsForPosition([light, def], position);
      const local = selected.find((s) => s.light === light)!;
      weights.push(local.weight);
    }

    // Monotonically non-increasing as distance grows (falloff only ever reduces the local share).
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThanOrEqual(weights[i - 1] + 1e-9);
    }

    // No adjacent pair jumps by more than epsilon -- a step function (e.g. flat 1.0 until the light
    // drops out of range, then 0) would fail this on the boundary step.
    for (let i = 1; i < weights.length; i++) {
      expect(Math.abs(weights[i] - weights[i - 1])).toBeLessThanOrEqual(epsilon);
    }

    // And it is a genuine ramp, not a constant: the ends differ substantially.
    expect(weights[0]).toBeCloseTo(1, 6);
    expect(weights[weights.length - 1]).toBeCloseTo(0, 6);
  });
});
