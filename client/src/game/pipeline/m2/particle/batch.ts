import * as THREE from 'three';

import { ParticlePool } from './pool';
import {
  evaluateFBlockAlpha,
  evaluateFBlockCell,
  evaluateFBlockColor,
  evaluateFBlockVec2,
} from './tracks';

const scratchColor = { r: 1, g: 1, b: 1 };
const scratchScale = { x: 1, y: 1 };
const scratchPosition = new THREE.Vector3();

/**
 * One draw call's worth of particles.
 *
 * A unit quad instanced once per live particle. The per-instance attributes carry everything that
 * varies: world position, scale, rotation, colour and the sub-rect of the flipbook to sample. The
 * vertex shader billboards the quad in view space, so nothing here has to face the camera.
 */
export class ParticleBatch extends THREE.Mesh {

  readonly capacity: number;

  private rows: number;
  private columns: number;

  private offsets: Float32Array;
  private scales: Float32Array;
  private rotations: Float32Array;
  private colors: Float32Array;
  private uvRects: Float32Array;

  constructor(material: any, capacity: number, rows: number, columns: number) {
    super();

    this.capacity = capacity;
    this.rows = Math.max(1, rows);
    this.columns = Math.max(1, columns);

    const geometry = new THREE.InstancedBufferGeometry();

    // A unit quad spanning -0.5..0.5, which the vertex shader scales and spins per instance.
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
       0.5,  0.5, 0,
      -0.5,  0.5, 0,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this.offsets = new Float32Array(capacity * 3);
    this.scales = new Float32Array(capacity * 2);
    this.rotations = new Float32Array(capacity);
    this.colors = new Float32Array(capacity * 4);
    this.uvRects = new Float32Array(capacity * 4);

    geometry.setAttribute('iOffset', new THREE.InstancedBufferAttribute(this.offsets, 3));
    geometry.setAttribute('iScale', new THREE.InstancedBufferAttribute(this.scales, 2));
    geometry.setAttribute('iRotation', new THREE.InstancedBufferAttribute(this.rotations, 1));
    geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.colors, 4));
    geometry.setAttribute('iUvRect', new THREE.InstancedBufferAttribute(this.uvRects, 4));

    geometry.instanceCount = 0;

    this.geometry = geometry;
    this.material = material;

    // Particles are placed in world space by the packing pass, so the mesh itself must not add a
    // transform on top. Frustum culling is off because the geometry's bounding volume describes the
    // unit quad at the origin, not where the instances actually are.
    this.matrixAutoUpdate = false;
    this.frustumCulled = false;
  }

  /**
   * Fill the instanced attributes from a pool's live particles.
   *
   * @param worldMatrix transform from the emitter's local space into world space
   * @returns the number of instances written
   */
  pack(pool: ParticlePool, definition: any, worldMatrix: THREE.Matrix4): number {
    const cellCount = this.rows * this.columns;
    const cellWidth = 1 / this.columns;
    const cellHeight = 1 / this.rows;

    let index = 0;

    pool.forEachLive((slot) => {
      if (index >= this.capacity) {
        return;
      }

      const lifespan = pool.lifespan[slot];
      const t = lifespan > 0 ? Math.min(1, pool.age[slot] / lifespan) : 1;

      scratchPosition.set(
        pool.position[slot * 3],
        pool.position[slot * 3 + 1],
        pool.position[slot * 3 + 2],
      ).applyMatrix4(worldMatrix);

      this.offsets[index * 3] = scratchPosition.x;
      this.offsets[index * 3 + 1] = scratchPosition.y;
      this.offsets[index * 3 + 2] = scratchPosition.z;

      evaluateFBlockVec2(definition.scaleTrack, t, scratchScale);
      this.scales[index * 2] = scratchScale.x;
      this.scales[index * 2 + 1] = scratchScale.y;

      this.rotations[index] = pool.spin[slot];

      evaluateFBlockColor(definition.colorTrack, t, scratchColor);
      this.colors[index * 4] = scratchColor.r;
      this.colors[index * 4 + 1] = scratchColor.g;
      this.colors[index * 4 + 2] = scratchColor.b;
      this.colors[index * 4 + 3] = evaluateFBlockAlpha(definition.alphaTrack, t);

      const cell = cellCount > 1
        ? Math.min(cellCount - 1, Math.max(0, evaluateFBlockCell(definition.headUVAnim, t)))
        : 0;
      const column = cell % this.columns;
      const row = Math.floor(cell / this.columns);

      this.uvRects[index * 4] = column * cellWidth;
      this.uvRects[index * 4 + 1] = row * cellHeight;
      this.uvRects[index * 4 + 2] = cellWidth;
      this.uvRects[index * 4 + 3] = cellHeight;

      index++;
    });

    const geometry = this.geometry as THREE.InstancedBufferGeometry;
    geometry.instanceCount = index;

    // Only the live prefix changed, so bound the upload to it. r159 replaced the old single
    // `updateRange` object with these accumulating ranges, hence the clear-then-add each frame.
    for (const name of ['iOffset', 'iScale', 'iRotation', 'iColor', 'iUvRect']) {
      const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
      attribute.clearUpdateRanges();
      if (index > 0) {
        attribute.addUpdateRange(0, index * attribute.itemSize);
      }
      attribute.needsUpdate = true;
    }

    return index;
  }

}
