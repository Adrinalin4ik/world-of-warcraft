/**
 * @jest-environment node
 */
import * as THREE from 'three';
import { AreaLight } from '../types';
import { selectLightsForPosition } from '../utils';

// Minimal AreaLight fixture -- selectLightsForPosition only reads id/position/falloffStart/
// falloffEnd, never `params`, so params is left empty here.
const mkLight = (
  id: number,
  x: number,
  y: number,
  z: number,
  falloffStart: number,
  falloffEnd: number,
): AreaLight => ({
  id,
  mapId: 0,
  position: new THREE.Vector3(x, y, z),
  falloffStart,
  falloffEnd,
  params: [],
});

// A map-wide default light: no falloff, so it is identified by falloffEnd === 0 alone (position no
// longer matters -- see utils.ts's doc for why the old MAP_CORNER position check was too strict).
const mkDefault = (id: number, x = 0, y = 0, z = 0): AreaLight =>
  mkLight(id, x, y, z, 0, 0);

const sumWeights = (weights: Array<{ weight: number }>) =>
  weights.reduce((sum, w) => sum + w.weight, 0);

describe('selectLightsForPosition seed selection', () => {
  it('identifies a default light by falloffEnd === 0 alone, regardless of its position', () => {
    // Not at the map corner -- this is exactly the map-571 shape: a real falloffEnd === 0 record that
    // the old position-gated check rejected, resolving zero area lights.
    const local = mkLight(1, 75, 0, 0, 50, 100); // distance 75 -> raw weight 0.5
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

  it('a single local light plus a default light keeps varying continuously with distance -- round-1 regression', () => {
    // Before the fix, normalising a single selected light always drove it to weight 1 regardless of
    // distance. With a default light present, the local light's own weight must still track its raw
    // falloff share, and the default must absorb the complement.
    const near = mkLight(1, 60, 0, 0, 50, 100); // distance 60 -> falloff 0.2 -> raw weight 0.8
    const far = mkLight(2, 90, 0, 0, 50, 100); // distance 90 -> falloff 0.8 -> raw weight 0.2
    const def = mkDefault(3);

    const nearSelected = selectLightsForPosition([near, def], new THREE.Vector3(0, 0, 0));
    const farSelected = selectLightsForPosition([far, def], new THREE.Vector3(0, 0, 0));

    const nearLocal = nearSelected.find((s) => s.light === near)!;
    const farLocal = farSelected.find((s) => s.light === far)!;

    expect(nearLocal.weight).toBeCloseTo(0.8, 6);
    expect(farLocal.weight).toBeCloseTo(0.2, 6);
    expect(nearLocal.weight).not.toBeCloseTo(farLocal.weight, 3);
  });

  it('picks the same seed regardless of camera position when the map has two falloffEnd === 0 records', () => {
    // Round-2 regression: the seed used to be the NEAREST falloffEnd === 0 record, so it could swap
    // identity as the camera moved even between two default-type records. It must now be decided by
    // id alone, independent of where the camera is standing.
    const defA = mkDefault(5, 0, 0, 0);
    const defB = mkDefault(2, 500, 500, 500); // lower id -- always wins the tie-break

    const near = selectLightsForPosition([defA, defB], new THREE.Vector3(0, 0, 0));
    const far = selectLightsForPosition([defA, defB], new THREE.Vector3(9999, 9999, 9999));

    // Both resolves should be seeded by defB (id 2) alone, at weight 1, regardless of camera position.
    expect(near).toHaveLength(1);
    expect(far).toHaveLength(1);
    expect(near[0].light.id).toBe(2);
    expect(far[0].light.id).toBe(2);
    expect(near[0].weight).toBeCloseTo(1, 6);
    expect(far[0].weight).toBeCloseTo(1, 6);
  });

  it('seeds from the record with the largest falloffEnd when the map has no default record, tie-broken by lowest id', () => {
    // Warsong Gulch (map 489) shape: no falloffEnd === 0 record anywhere on the map. The seed must be
    // decided from the data (largest falloffEnd), never from which light happens to be nearest the
    // camera -- that was round 2's bug (see the smoothness test below for why it matters).
    const closer = mkLight(1, 85, 0, 0, 50, 100); // distance 85 -> falloff 0.7 -> raw weight 0.3; not the seed
    const broader = mkLight(2, 0, 900, 0, 50, 200); // largest falloffEnd on the map -> the seed

    const selected = selectLightsForPosition([closer, broader], new THREE.Vector3(0, 0, 0));

    expect(selected).toHaveLength(2);
    expect(sumWeights(selected)).toBeCloseTo(1, 6);

    const seedEntry = selected.find((s) => s.light === broader)!;
    const localEntry = selected.find((s) => s.light === closer)!;

    // `closer` keeps its own raw falloff share; `broader` (the seed) absorbs the rest, not because it
    // is nearer or farther, but because it is the seed.
    expect(localEntry.weight).toBeCloseTo(0.3, 6);
    expect(seedEntry.weight).toBeCloseTo(0.7, 6);
  });

  it('returns an empty selection when there are no light records for the map at all', () => {
    const selected = selectLightsForPosition([], new THREE.Vector3(0, 0, 0));
    expect(selected).toEqual([]);
  });

  it('does not divide by zero when the map has a single light exactly on its own falloff boundary', () => {
    // A lone light on the map becomes the seed by definition (largest falloffEnd of one), so the full
    // leftover lands on it regardless of its own raw falloff share.
    const light = mkLight(1, 100, 0, 0, 50, 100);
    const selected = selectLightsForPosition([light], new THREE.Vector3(0, 0, 0));

    expect(selected).toHaveLength(1);
    expect(Number.isNaN(selected[0].weight)).toBe(false);
    expect(selected[0].weight).toBeCloseTo(1, 6);
  });

  it('never produces NaN weights, even with an empty light list', () => {
    const selected = selectLightsForPosition([], new THREE.Vector3(0, 0, 0));
    expect(selected.every((s) => !Number.isNaN(s.weight))).toBe(true);
  });

  it('never double-counts the seed as a selected local light', () => {
    // The seed sits well within its own falloff band at the sampled position -- if it were left in
    // the local pool as well as seeded, it would appear twice, or its weight would double-count.
    const seed = mkDefault(1); // falloffEnd 0 -- identified as the seed outright
    const other = mkLight(2, 40, 0, 0, 20, 80);

    const selected = selectLightsForPosition([seed, other], new THREE.Vector3(0, 0, 0));

    const seedEntries = selected.filter((s) => s.light === seed);
    expect(seedEntries).toHaveLength(1);
  });
});

describe('selectLightsForPosition smoothness', () => {
  it('changes a light\'s resolved weight monotonically and continuously across its falloff band (default-light seed)', () => {
    // Walk the camera from just inside falloffStart to just past falloffEnd in small steps, along with
    // a default light to absorb the complement (the realistic, fixed shape). The regression this test
    // exists for: normalising drove the local weight to a flat 1.0 for every step, which is neither
    // monotonic movement nor a plain constant -- it hid the ramp entirely. A merely-sums-to-1 test
    // cannot tell that apart from the fix; only sampling adjacent steps can.
    const falloffStart = 50;
    const falloffEnd = 150;
    const light = mkLight(1, 0, 0, 0, falloffStart, falloffEnd);
    const def = mkDefault(2);

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

  it('changes both lights\' weights continuously across a drop-out point, with no default light present -- round-2 regression', () => {
    // The exact counterexample the round-2 review raised: light A sits near the camera's path but has
    // a SMALL falloffEnd, so it is spent (near-zero raw weight) just before it drops out of range.
    // Light B is farther but has a LARGE falloffEnd, so it is the seed (largest falloffEnd, no
    // falloffEnd === 0 record on this map) and holds the leftover throughout.
    //
    // Under round 1's "hand the leftover to selectedLights[0] (nearest in range)" rule, the instant A
    // drops out of range, the leftover it was holding transfers instantaneously to B, which jumps in a
    // single step. Seeding by `findSeedLight` (a property of the data, not of which light happens to
    // be nearest) removes that: B holds the leftover the entire time, so its weight moves only as A's
    // own raw share moves -- continuously.
    // falloffStart must be > 0 for a graded ramp at all -- at falloffStart === 0 the falloff formula's
    // own guard (`falloffStart > 0 && falloffEnd > 0`) disables the gradient entirely and A would sit
    // at a flat weight of 1 for its whole range, which is a different (and uninteresting) shape than
    // the one this test means to exercise.
    const lightA = mkLight(1, 0, 0, 0, 20, 60);
    const lightB = mkLight(2, 200, 0, 0, 0, 300); // largest falloffEnd on the map -> B is the seed

    const steps = 40;
    const epsilon = 1 / steps + 0.02;

    // Walk the camera from inside A's full-weight zone, through its falloff ramp, and out past
    // falloffEnd where it drops out of range entirely.
    const startDistance = 20;
    const endDistance = 70;

    const weightsA: number[] = [];
    const weightsB: number[] = [];
    const seedIds: number[] = [];

    for (let i = 0; i <= steps; i++) {
      const x = startDistance + (i / steps) * (endDistance - startDistance);
      const position = new THREE.Vector3(x, 0, 0);
      const selected = selectLightsForPosition([lightA, lightB], position);

      const a = selected.find((s) => s.light === lightA);
      const b = selected.find((s) => s.light === lightB)!;

      weightsA.push(a ? a.weight : 0);
      weightsB.push(b.weight);
      seedIds.push(b.light.id);
    }

    for (let i = 1; i < weightsA.length; i++) {
      expect(Math.abs(weightsA[i] - weightsA[i - 1])).toBeLessThanOrEqual(epsilon);
      expect(Math.abs(weightsB[i] - weightsB[i - 1])).toBeLessThanOrEqual(epsilon);
    }

    // The seed (the light holding the leftover) never changes identity across the walk.
    expect(new Set(seedIds).size).toBe(1);
    expect(seedIds[0]).toBe(lightB.id);

    // A genuine transition happened, not two flat lines: A ends at/near 0 once out of range, B ends
    // at/near 1 once A has nothing left to claim.
    expect(weightsA[weightsA.length - 1]).toBeCloseTo(0, 3);
    expect(weightsB[weightsB.length - 1]).toBeCloseTo(1, 3);
  });
});
