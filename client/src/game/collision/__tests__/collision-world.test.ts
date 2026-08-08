/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { CollisionWorld } from '../collision-world';
import { CollisionLayer } from '../types';

const RADIUS = 1 / 3;
const HALF_SEGMENT = 2.0277777 / 2 - RADIUS;

/** A wide horizontal slab at z, as a hull mesh. */
function floorSlab(z: number) {
  const s = 20;
  const positions = new Float32Array([
    -s, -s, z, s, -s, z, s, s, z,
    -s, -s, z, s, s, z, -s, s, z,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld(true);

  return mesh;
}

/** A vertical wall in the x = at plane, as a hull mesh. */
function wallSlab(at: number) {
  const s = 20;
  const positions = new Float32Array([
    at, -s, -s, at, s, -s, at, s, s,
    at, -s, -s, at, s, s, at, -s, s,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld(true);

  return mesh;
}

describe('CollisionWorld', () => {
  it('reaches geometry registered on any provider', () => {
    const world = new CollisionWorld();
    world.doodads.add(floorSlab(0));

    const cast = world.castFor(CollisionLayer.Walk, RADIUS, HALF_SEGMENT);
    const hit = cast(new THREE.Vector3(0, 0, 6), new THREE.Vector3(0, 0, -1), 20);

    expect(hit).not.toBeNull();
    expect(hit!.normal.z).toBeCloseTo(1, 5);
  });

  it('gathers over the whole sweep, not just its origin', () => {
    // A broadphase box built around the origin alone would sail straight through every wall a
    // running step reaches.
    const world = new CollisionWorld();
    world.doodads.add(wallSlab(15));

    const cast = world.castFor(CollisionLayer.Walk, RADIUS, HALF_SEGMENT);
    const hit = cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), 30);

    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(15 - RADIUS, 2);
  });

  it('serves independent casts for the two audiences', () => {
    const world = new CollisionWorld();
    world.doodads.add(floorSlab(0));

    const walk = world.castFor(CollisionLayer.Walk, RADIUS, HALF_SEGMENT);
    const camera = world.castFor(CollisionLayer.Camera, 0.3, 0);

    expect(walk(new THREE.Vector3(0, 0, 6), new THREE.Vector3(0, 0, -1), 20)).not.toBeNull();
    expect(camera(new THREE.Vector3(0, 0, 6), new THREE.Vector3(0, 0, -1), 20)).not.toBeNull();
  });

  it('does not let one cast leak candidates into the next', () => {
    // The candidate list is reused per frame to avoid allocating; failing to reset it would make
    // every cast see the previous cast's geometry.
    const world = new CollisionWorld();
    world.doodads.add(wallSlab(5));

    const cast = world.castFor(CollisionLayer.Walk, RADIUS, HALF_SEGMENT);
    cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), 30);
    const away = cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-1, 0, 0), 30);

    expect(away).toBeNull();
  });

  it('clears every provider', () => {
    const world = new CollisionWorld();
    world.doodads.add(floorSlab(0));
    world.clear();

    const cast = world.castFor(CollisionLayer.Walk, RADIUS, HALF_SEGMENT);

    expect(cast(new THREE.Vector3(0, 0, 6), new THREE.Vector3(0, 0, -1), 20)).toBeNull();
  });

  it('reports no hit on an empty world rather than throwing', () => {
    const world = new CollisionWorld();
    const cast = world.castFor(CollisionLayer.Walk, RADIUS, HALF_SEGMENT);

    expect(cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), 100)).toBeNull();
    expect(world.surfaceAt(0, 0, { wmoGroup: null })).toBeNull();
  });
});
