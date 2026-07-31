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

const sumWeights = (weights: Array<{ weight: number }>) =>
  weights.reduce((sum, w) => sum + w.weight, 0);

describe('selectLightsForPosition weight normalisation', () => {
  it('normalises a single selected light to weight 1, even though its raw falloff share is partial', () => {
    // falloffStart=50, falloffEnd=100, distance=75 -> raw falloff share is 0.5, same shape as the
    // Warsong Gulch shot A/B evidence (a lone light contributing a fraction under 1).
    const light = mkLight(75, 0, 0, 50, 100);
    const selected = selectLightsForPosition([light], new THREE.Vector3(0, 0, 0));

    expect(selected).toHaveLength(1);
    expect(sumWeights(selected)).toBeCloseTo(1, 6);
    expect(selected[0].weight).toBeCloseTo(1, 6);
  });

  it('normalises several selected lights (no default-light record) so weights sum to 1, preserving their relative share', () => {
    // Neither light sits at the map corner with falloffEnd === 0, so there is no default light to
    // absorb the remainder -- this is the Warsong Gulch (map 489) regression shape exactly.
    const closer = mkLight(85, 0, 0, 50, 100); // distance 85 -> falloff 0.7 -> raw weight 0.3
    const farther = mkLight(0, 90, 0, 50, 100); // distance 90 -> falloff 0.8 -> raw weight 0.2

    const selected = selectLightsForPosition([closer, farther], new THREE.Vector3(0, 0, 0));

    expect(selected).toHaveLength(2);
    expect(sumWeights(selected)).toBeCloseTo(1, 6);

    // Raw shares were 0.3 and 0.2 (sum 0.5) -- normalising must preserve their 3:2 ratio, i.e. 0.6/0.4.
    const closerEntry = selected.find((s) => s.light === closer)!;
    const fartherEntry = selected.find((s) => s.light === farther)!;
    expect(closerEntry.weight).toBeCloseTo(0.6, 6);
    expect(fartherEntry.weight).toBeCloseTo(0.4, 6);
  });

  it('does not divide by zero on an empty selection, and leaves it as an empty array rather than NaN-laden', () => {
    // Every light is farther than its own falloffEnd from the camera, so nothing is selected at all.
    const light = mkLight(1000, 0, 0, 50, 100);
    const selected = selectLightsForPosition([light], new THREE.Vector3(0, 0, 0));

    expect(selected).toEqual([]);
  });

  it('does not divide by zero when the only selected light has zero weight', () => {
    // Sitting exactly on the falloffEnd boundary: falloff == 1, so the raw weight is exactly 0.
    const light = mkLight(100, 0, 0, 50, 100);
    const selected = selectLightsForPosition([light], new THREE.Vector3(0, 0, 0));

    expect(selected).toHaveLength(1);
    expect(selected[0].weight).toBe(0);
    expect(Number.isNaN(selected[0].weight)).toBe(false);
  });
});
