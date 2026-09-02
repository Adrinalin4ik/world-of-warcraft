import * as THREE from 'three';

import { RibbonBatch, RibbonMaterial } from './batch';
import { RibbonRuntime } from './runtime';

/**
 * THE RIBBON LANE -- register a loaded M2's ribbon emitters, step them, draw their strips.
 *
 * Deliberately shaped as a sibling of `ParticleManager` rather than folded into it: the two share the
 * group, the cull rule and the buffer discipline, but a ribbon's geometry, shader and simulation are
 * all different (see `batch.ts` on why billboarding a strip is wrong). Two lanes with one convention
 * beats one lane with two code paths.
 *
 * Nothing rendered ribbons in this client before, which is why Lightning Bolt's projectile and precast
 * -- **3 ribbons and 0 particle emitters each** -- had only a bind-pose mesh to show.
 */
export class RibbonManager {
  /** Beyond this, a ribbon is not stepped and not drawn. Same value and reason as `ParticleManager`. */
  static CULL_DISTANCE = 120;

  private group: THREE.Object3D;

  private registered = new WeakSet<object>();

  private live: Array<{
    instance: any;
    runtime: RibbonRuntime;
    batch: RibbonBatch;
    bone: THREE.Object3D | null;
    culled: boolean;
  }> = [];

  private readiness = new WeakMap<object, Promise<void>>();

  private static readonly SETTLED: Promise<void> = Promise.resolve();

  /** WHAT THE LANE DID -- a ribbon carries no `ModelPart` and no particle emitter, so it is invisible
   * to both the visibility census and the particle census. The reference records the same hole:
   * "ninety Caverns-of-Time energy trails ... read, on every instrument we had, as a scene with
   * nothing in it" (`benilla-world/src/ribbons.rs:40-45`). */
  public stats = {
    ribbons: 0, drawn: 0, segments: 0, skippedNoTexture: 0, skippedNoBone: 0,
  };

  constructor(group: THREE.Object3D) {
    this.group = group;
  }

  /** How many ribbon emitters this instance contributed. Zero for the great majority of models. */
  register(instance: any): number {
    if (!instance || this.registered.has(instance)) {
      return 0;
    }
    const definitions: any[] = instance.ribbonEmitters || [];
    if (definitions.length === 0) {
      return 0;
    }

    const built: typeof this.live = [];
    const settling: Array<Promise<void>> = [];

    try {
      for (const definition of definitions) {
        // The texture comes through `textureIndices` -> the M2 texture table, and the blend through
        // `materialIndices` -> the render-flags table. Both are M2Arrays; the shipped lightning
        // ribbons carry exactly one entry each.
        const textureIndex = (definition.textureIndices ?? [])[0];
        const texture = (instance.textures || [])[textureIndex];
        const texturePath = texture && texture.filename ? texture.filename : '';
        if (!texturePath) {
          // Same rule the particle lane takes: an emitter with no resolvable texture can never draw,
          // so building a batch for it is pure cost. Counted, not silent.
          this.stats.skippedNoTexture += 1;
          continue;
        }

        const materialIndex = (definition.materialIndices ?? [])[0];
        const material = (instance.materials || [])[materialIndex];
        const blendingMode = material && typeof material.blendingMode === 'number'
          ? material.blendingMode : 0;

        // The emitter's bone is where the node comes from every frame. A ribbon whose bone is out of
        // range cannot be placed, and guessing a fallback bone would put a lightning trail on the
        // wrong limb -- so it is refused and counted.
        const bone = (instance.bones || [])[definition.boneIndex] ?? null;
        if (bone === null) {
          this.stats.skippedNoBone += 1;
          continue;
        }

        const runtime = new RibbonRuntime(definition);
        const ribbonMaterial = new RibbonMaterial(texturePath, blendingMode);
        const batch = new RibbonBatch(ribbonMaterial, runtime.capacity);
        settling.push(ribbonMaterial.ready);
        built.push({
          instance, runtime, batch, bone, culled: false,
        });
      }
    } catch (error) {
      // Built locally first so a throw partway through leaves nothing half-registered -- the guard
      // `ParticleManager.register` states, and for the same reason: a malformed definition must not
      // wedge the instance behind the `registered` check.
      for (const entry of built) {
        entry.batch.disposeBatch();
      }
      const path = instance && instance.path ? instance.path : instance;
      // eslint-disable-next-line no-console
      console.error('RibbonManager: failed to register ribbons for', path, error);
      return 0;
    }

    if (built.length === 0) {
      return 0;
    }

    this.registered.add(instance);
    for (const entry of built) {
      this.group.add(entry.batch);
      this.live.push(entry);
    }
    this.stats.ribbons += built.length;
    this.readiness.set(
      instance,
      settling.length === 1 ? settling[0] : Promise.all(settling).then(() => undefined),
    );
    return built.length;
  }

  /** The readiness handle, same contract as `ParticleManager#ready`: never rejects, never gates. */
  ready(instance: any): Promise<void> {
    if (!instance) {
      return RibbonManager.SETTLED;
    }
    return this.readiness.get(instance) ?? RibbonManager.SETTLED;
  }

  unregister(instance: any): void {
    if (!this.registered.has(instance)) {
      return;
    }
    this.registered.delete(instance);
    this.readiness.delete(instance);
    this.live = this.live.filter((entry) => {
      if (entry.instance !== instance) {
        return true;
      }
      this.group.remove(entry.batch);
      entry.batch.disposeBatch();
      this.stats.ribbons -= 1;
      return false;
    });
  }

  /**
   * One frame. Returns immediately with nothing live, so a session with no trail pays one compare.
   *
   * Reads `bone.matrixWorld` rather than recomputing it: `World#updateDynamicMatrices` force-walks
   * every non-static scene child recursively, which reaches an effect model's bones through its host,
   * and the particle lane's own `updateMatrixWorld(false)` runs on the same instances.
   */
  animate(delta: number, camera: THREE.Camera): void {
    if (this.live.length === 0) {
      return;
    }
    const cullSquared = RibbonManager.CULL_DISTANCE * RibbonManager.CULL_DISTANCE;
    const dt = Math.min(delta, 0.1);
    this.stats.drawn = 0;
    this.stats.segments = 0;

    for (const entry of this.live) {
      // The instance's own transform decides the cull, exactly as it does for particles -- the ribbon
      // nodes are near it by construction.
      scratchPosition.setFromMatrixPosition(entry.instance.matrixWorld);
      if (camera.position.distanceToSquared(scratchPosition) > cullSquared) {
        if (!entry.culled) {
          // Release on the TRANSITION into culled, like the particle pool: an unstepped trail would
          // otherwise resume with a stale strip stretched across wherever it was last seen.
          entry.runtime.reset();
          entry.culled = true;
        }
        entry.batch.visible = false;
        continue;
      }
      entry.culled = false;

      // The bone subtree has to be current before its matrix is read. `updateMatrixWorld(false)` is a
      // no-op when nothing upstream dirtied it, which is the common case after the world's own walk.
      entry.instance.updateMatrixWorld(false);

      entry.runtime.step(dt, entry.bone!.matrixWorld);
      const segments = entry.batch.pack(entry.runtime);
      if (segments > 0) {
        this.stats.drawn += 1;
        this.stats.segments += segments;
      }
    }
  }
}

/** Reused across `animate` calls so the per-frame path allocates nothing. */
const scratchPosition = new THREE.Vector3();

export default RibbonManager;
