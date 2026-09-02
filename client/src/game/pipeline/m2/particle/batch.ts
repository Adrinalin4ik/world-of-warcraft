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
const scratchWorldScale = new THREE.Vector3();

/**
 * One draw call's worth of particles.
 *
 * A unit quad instanced once per live particle. The per-instance attributes carry everything that
 * varies: world position, scale, rotation, colour and the sub-rect of the flipbook to sample. The
 * vertex shader billboards the quad in view space, so nothing here has to face the camera.
 */
/**
 * TWO CONVENTIONS, AND EVERY SPRITE IN THE GAME WAS HALF ITS SIZE BECAUSE THEY WERE NEVER RECONCILED.
 *
 * The M2 scale track is a **HALF-size** -- a radius. The reference states it and byte-verifies it in
 * the client's own quad writer `0x7b2a50`: "The rendered **half-size** is the over-life scale ramp x
 * a gated twinkle multiplier" (`benilla-formats/src/particles.rs:418-419`, wow-re
 * `part-simspace-fields.md`).
 *
 * `shader.vert` builds the quad as `position.xy * iScale` where "`position` is the unit quad,
 * spanning -0.5..0.5" -- so `iScale` is the quad's **FULL extent**. Packing the ramp value straight
 * into it therefore rendered a half-size of `ramp / 2`: a constant factor of exactly 2, on every
 * particle of every emitter in the game.
 *
 * That single factor is the shape of what the owner reported four separate times on four unrelated
 * chains -- the healing precast leaves ("очень маленькие"), the hand glow, a Shadow Bolt projectile,
 * and a warlock summon -- plus, by arithmetic, the BEADED trail: Fireball authors 50 births/sec at
 * 24 u/s, so births land 0.48 units apart, and a sprite whose measured ramp is ~0.2 drew 0.2 wide
 * against a 0.48 gap (a dotted line by construction) where it should draw 0.4 and very nearly touch.
 * Four size complaints and the beading were one defect.
 *
 * CORRECTED HERE AND NOT IN THE SHADER, deliberately. The shader's contract ("`iScale` is the full
 * extent of a -0.5..0.5 quad") is self-consistent and is shared with its own UV derivation, which
 * this project has already broken once by "simplifying" it. The conversion belongs at the boundary
 * where the file's semantic is read, which is here.
 *
 * NOT APPLIED, and named rather than folded in silently: the **gated twinkle multiplier** from the
 * same sentence -- `min != max => noise(speed * age) * (max - min) + min`, skipped entirely when
 * `min == max`. This client decodes `twinkleSpeed / twinklePercent / twinkleScaleMin /
 * twinkleScaleMax` and reads none of them. Surveyed on the served build across 1580 emitters in 315
 * models, **903 (57.2%) author `min != max`** and 677 (42.8%) are the degenerate case the reference
 * skips -- so this is a live multiplier on the majority of emitters, not a corner. It is a separate
 * port with a real risk attached (a `{0, 0.5}` range at speed 0 is a SHRINK, so applying it in the
 * same commit as a 2x growth would confound both), and it needs the noise function pinned first.
 */
const HALF_SIZE_TO_EXTENT = 2;

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
  pack(
    pool: ParticlePool,
    definition: any,
    worldMatrix: THREE.Matrix4,
    /**
     * A PER-INSTANCE multiplier on each particle's own billboard size. 1 leaves the asset alone.
     *
     * Separate from the world scale below, and the distinction is the owner's own correction:
     * "window.worldSparkleScale(4) не увеличивает размер партикла, а только радиус вокруг куста. А я
     * хотел просто увеличить размер каждой частицы". Scaling the INSTANCE grows the emitter's volume --
     * every spawn position is transformed by `worldMatrix`, so the cloud spreads -- which is right for a
     * doodad placed at scale 3 and wrong as a way to make particles bigger. This multiplies the size
     * track and nothing else, so the cloud keeps its authored shape and the sprites in it grow.
     *
     * Read off the INSTANCE by the manager rather than stamped onto the definition, deliberately:
     * `M2Blueprint.load` returns a clone that can share its source's definitions, and writing one would
     * resize every copy of that model in the zone -- the "a SHARED thing is not yours to write" trap
     * `CLAUDE.md` records three rounds of.
     */
    sizeScale = 1,
  ): number {
    const cellCount = this.rows * this.columns;
    const cellWidth = 1 / this.columns;
    const cellHeight = 1 / this.rows;

    // Extracted once per pack call, not per particle: `worldMatrix` applies to the doodad's position
    // already (via applyMatrix4 below), but the scale track values are billboard sizes in the emitter's
    // local space and never otherwise pick up the instance's world scale. A doodad placed at scale 3
    // must render a triple-size flame, not a triple-size torch with a normal-size flame on top of it.
    // Particles are billboards facing the camera, so there is no meaningful way to apply x/y/z scale
    // separately -- take the largest axis as a single uniform factor.
    if (typeof (worldMatrix as any).extractScale === 'function') {
      (worldMatrix as any).extractScale(scratchWorldScale);
    } else {
      const e = worldMatrix.elements;
      scratchWorldScale.set(
        Math.hypot(e[0], e[1], e[2]),
        Math.hypot(e[4], e[5], e[6]),
        Math.hypot(e[8], e[9], e[10]),
      );
    }
    const worldScaleFactor = Math.max(scratchWorldScale.x, scratchWorldScale.y, scratchWorldScale.z);

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
      // THE HALF-SIZE -> FULL-EXTENT CONVERSION. See `HALF_SIZE_TO_EXTENT`: this is the one place the
      // M2's "radius" convention meets this renderer's "full width" one, and it was missing.
      this.scales[index * 2] = scratchScale.x * HALF_SIZE_TO_EXTENT * worldScaleFactor * sizeScale;
      this.scales[index * 2 + 1] = scratchScale.y * HALF_SIZE_TO_EXTENT * worldScaleFactor * sizeScale;

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
