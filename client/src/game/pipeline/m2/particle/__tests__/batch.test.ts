/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { ParticleBatch } from '../batch';
import { ParticlePool } from '../pool';

// A material stand-in: ParticleBatch only stores it, and constructing the real one would fetch a texture.
const stubMaterial: any = new THREE.MeshBasicMaterial();

const definition = {
  colorTrack: { keys: [{ time: 0, value: { x: 255, y: 0, z: 0 } }] },
  alphaTrack: { keys: [{ time: 0, value: 32767 }] },
  scaleTrack: { keys: [{ time: 0, value: [2, 3] }] },
  headUVAnim: { keys: [{ time: 0, value: 0 }] },
  scaleVary: [0, 0],
};

const seed = (pool: ParticlePool, position: number[], lifespan: number) => {
  const slot = pool.allocate();
  pool.position.set(position, slot * 3);
  pool.lifespan[slot] = lifespan;
  pool.age[slot] = 0;
  pool.spin[slot] = 0;
  return slot;
};

describe('ParticleBatch', () => {
  it('writes one instance per live particle and reports the count', () => {
    const pool = new ParticlePool(8);
    seed(pool, [1, 2, 3], 5);
    seed(pool, [4, 5, 6], 5);

    const batch = new ParticleBatch(stubMaterial, 8, 1, 1);
    const count = batch.pack(pool, definition, new THREE.Matrix4());

    expect(count).toBe(2);
    expect((batch.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);
  });

  it('writes nothing for an empty pool', () => {
    const pool = new ParticlePool(8);
    const batch = new ParticleBatch(stubMaterial, 8, 1, 1);

    expect(batch.pack(pool, definition, new THREE.Matrix4())).toBe(0);
    expect((batch.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);
  });

  it('transforms particle positions by the world matrix', () => {
    const pool = new ParticlePool(4);
    seed(pool, [1, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);
    const worldMatrix = new THREE.Matrix4().makeTranslation(10, 20, 30);
    batch.pack(pool, definition, worldMatrix);

    const offset = batch.geometry.getAttribute('iOffset');
    expect(offset.getX(0)).toBeCloseTo(11, 4);
    expect(offset.getY(0)).toBeCloseTo(20, 4);
    expect(offset.getZ(0)).toBeCloseTo(30, 4);
  });

  it('applies the colour and alpha tracks', () => {
    const pool = new ParticlePool(4);
    seed(pool, [0, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);
    batch.pack(pool, definition, new THREE.Matrix4());

    const color = batch.geometry.getAttribute('iColor');
    expect(color.getX(0)).toBeCloseTo(1, 3);
    expect(color.getY(0)).toBeCloseTo(0, 3);
    expect(color.getW(0)).toBeCloseTo(1, 3);
  });

  /**
   * THIS TEST USED TO ASSERT THE DEFECT. It expected the authored track value to reach `iScale`
   * unchanged -- `(2, 3)` in, `(2, 3)` out -- which is exactly the missing conversion: the M2 track
   * is a HALF-size and `iScale` is the full extent of a -0.5..0.5 quad, so the sprite rendered at
   * half the size the file asks for. See `HALF_SIZE_TO_EXTENT` in `batch.ts` for the reference's
   * byte-verified statement. Doubling the expectation rather than deleting the test, because the
   * pass-through it pinned is still the thing worth pinning -- just against the right contract.
   */
  it('doubles the half-size scale track into the full extent of the quad', () => {
    const pool = new ParticlePool(4);
    seed(pool, [0, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);
    batch.pack(pool, definition, new THREE.Matrix4());

    const scale = batch.geometry.getAttribute('iScale');
    expect(scale.getX(0)).toBeCloseTo(4, 4);
    expect(scale.getY(0)).toBeCloseTo(6, 4);
  });

  it('derives the uv rect from the rows and columns of the flipbook', () => {
    const pool = new ParticlePool(4);
    seed(pool, [0, 0, 0], 5);

    // 2x2 atlas, cell 0 -> origin (0, 0), size (0.5, 0.5)
    const batch = new ParticleBatch(stubMaterial, 4, 2, 2);
    batch.pack(pool, definition, new THREE.Matrix4());

    const rect = batch.geometry.getAttribute('iUvRect');
    expect(rect.getZ(0)).toBeCloseTo(0.5, 5);
    expect(rect.getW(0)).toBeCloseTo(0.5, 5);
    expect(rect.getX(0)).toBeCloseTo(0, 5);
    expect(rect.getY(0)).toBeCloseTo(0, 5);
  });

  it('treats a 1x1 flipbook as the whole texture', () => {
    const pool = new ParticlePool(4);
    seed(pool, [0, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);
    batch.pack(pool, definition, new THREE.Matrix4());

    const rect = batch.geometry.getAttribute('iUvRect');
    expect(rect.getZ(0)).toBeCloseTo(1, 5);
    expect(rect.getW(0)).toBeCloseTo(1, 5);
  });

  it('never writes more instances than its capacity', () => {
    const pool = new ParticlePool(16);
    for (let i = 0; i < 16; i++) {
      seed(pool, [i, 0, 0], 5);
    }

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);

    expect(batch.pack(pool, definition, new THREE.Matrix4())).toBe(4);
  });

  it('marks the attributes for upload', () => {
    const pool = new ParticlePool(4);
    seed(pool, [0, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);

    // three's `needsUpdate` is a setter with no getter (BufferAttribute.js:155): assigning true
    // increments `version`, and reading the property back always yields undefined. `version` is
    // therefore the only observable evidence that the attribute was marked dirty.
    const names = ['iOffset', 'iScale', 'iRotation', 'iColor', 'iUvRect'];
    const before = names.map((name) => (batch.geometry.getAttribute(name) as THREE.BufferAttribute).version);

    batch.pack(pool, definition, new THREE.Matrix4());

    names.forEach((name, index) => {
      expect((batch.geometry.getAttribute(name) as THREE.BufferAttribute).version).toBeGreaterThan(before[index]);
    });
  });

  it('scales iScale by the world matrix scale (billboard sizes track doodad scale)', () => {
    const identityPool = new ParticlePool(4);
    seed(identityPool, [0, 0, 0], 5);
    const identityBatch = new ParticleBatch(stubMaterial, 4, 1, 1);
    identityBatch.pack(identityPool, definition, new THREE.Matrix4());
    const identityScale = identityBatch.geometry.getAttribute('iScale');

    const scaledPool = new ParticlePool(4);
    seed(scaledPool, [0, 0, 0], 5);
    const scaledBatch = new ParticleBatch(stubMaterial, 4, 1, 1);
    scaledBatch.pack(scaledPool, definition, new THREE.Matrix4().makeScale(3, 3, 3));
    const scaledScale = scaledBatch.geometry.getAttribute('iScale');

    expect(scaledScale.getX(0)).toBeCloseTo(identityScale.getX(0) * 3, 4);
    expect(scaledScale.getY(0)).toBeCloseTo(identityScale.getY(0) * 3, 4);
  });

  it('bounds the update range to the live prefix', () => {
    const pool = new ParticlePool(16);
    seed(pool, [0, 0, 0], 5);
    seed(pool, [1, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 16, 1, 1);
    batch.pack(pool, definition, new THREE.Matrix4());

    const offset = batch.geometry.getAttribute('iOffset') as THREE.BufferAttribute;
    expect(offset.updateRanges.length).toBe(1);
    // Two live particles, three components each.
    expect(offset.updateRanges[0]).toEqual({ start: 0, count: 6 });
  });
});
