/** The light-binding surface a material may implement. All members are optional. */
export interface LightBoundMaterial {
  mapLight?: unknown;
  setMapLight?(light: unknown): void;
  updateLightUniforms?(): void;
  /** Implemented by M2MaterialNew / M2MaterialNewShaders / M2MaterialLite. Opt-in, one-shot. */
  enableNewLightSystem?(camera: unknown, mapId?: number): void;
}

export interface ApplyResult {
  seen: number;
  applied: number;
}

interface Traversable {
  traverse(callback: (child: any) => void): void;
}

/**
 * The set of materials that want per-frame light uniforms.
 *
 * Replaces `WorldMap#updateAllMaterialsWithLight`'s per-frame `scene.traverse()`, which visited
 * every object and every material in the world once per frame purely to find the ones with a light
 * surface. Membership changes only when content streams in or out, so it is maintained at load
 * time and iterated flat per frame.
 *
 * `applyLight` reproduces `WorldMap#applyLightToMaterial` verbatim, including the `!==` identity
 * comparison rather than a truthiness check -- see the long note at world/map.js:246-273. M2
 * materials are cached and shared across placements AND across maps, while `changeMap` installs a
 * brand-new `MapLight` per zone. A truthiness check treats a stale reference as "already bound" and
 * only ever refreshes uniforms against a `MapLight` nobody ticks anymore, freezing that material's
 * fog and time of day.
 */
export class MaterialRegistry {
  private readonly materials = new Set<LightBoundMaterial>();

  /**
   * Materials added since the last `applyLight`, so a frame that skips the full pass still binds
   * whatever streamed in during it. See `applyLight`'s `revision` argument.
   */
  private readonly pending = new Set<LightBoundMaterial>();

  /** The `revision` and light object the last FULL pass ran against; see `applyLight`. */
  private lastRevision: number | null = null;
  private lastLight: unknown = undefined;

  get size(): number {
    return this.materials.size;
  }

  add(material: LightBoundMaterial | null | undefined): void {
    if (material) {
      // `pending` is added to unconditionally, even for a material already in `materials`. A repeat
      // costs one redundant refresh on the next frame; skipping it for a material that had been
      // deleted and re-added in the same frame would cost a permanently unbound material.
      this.materials.add(material);
      this.pending.add(material);
    }
  }

  /** Harvest every material on a freshly loaded subtree. Call once, at load, never per frame. */
  addFrom(object: Traversable | null | undefined): void {
    if (!object || typeof object.traverse !== 'function') {
      return;
    }
    object.traverse((child: any) => {
      const material = child?.material;
      if (!material) {
        return;
      }
      if (Array.isArray(material)) {
        for (const entry of material) {
          this.add(entry);
        }
      } else {
        this.add(material);
      }
    });
  }

  delete(material: LightBoundMaterial): void {
    this.materials.delete(material);
  }

  forEach(callback: (material: LightBoundMaterial) => void): void {
    this.materials.forEach(callback);
  }

  clear(): void {
    this.materials.clear();
  }

  /**
   * Bind and refresh every registered material against `current`.
   *
   * `revision` IS THE OPTIMISATION, and it is exact rather than a throttle.
   *
   * Every consumer of this registry refreshes by COPYING out of the one shared light -- seven
   * `Vector.copy` calls for `M2Material` (`m2/material/index.ts:718`), and the same shape for the ADT
   * chunk, liquid and WMO materials. Measured in Elwynn on a real world entry, this registry holds
   * **20 258** materials, so the per-frame refresh was ~141 000 vector copies, timed at **3.2 ms of
   * every frame** -- the single largest item inside `World#animate`'s 11 ms.
   *
   * And it was almost entirely redundant. Measured over 401 consecutive steady-state frames, the
   * light values those materials copy changed on **1** of them (0.25 %): `MapLight` resolves time of
   * day, sun colour and fog from tables that move on the order of game-minutes, not frames. Copying
   * an unchanged value into a uniform is a provable no-op, so skipping it changes no pixel.
   *
   * `revision` is `MapLight#revision`, which that class bumps only when the values it publishes
   * actually differ (see its own doc for exactly which values, and for the one it deliberately
   * excludes). When the revision and the light object are both unchanged, only `pending` -- the
   * materials that streamed in since the last call -- is processed. `seen` then reports what was
   * actually visited, which is what makes the skip visible on the debug readout rather than silent.
   *
   * OMITTING `revision` KEEPS THE OLD BEHAVIOUR (a full pass every call), which is what
   * `propagateMapLightToAllMaterials` and the tests want: a caller that cannot vouch for a revision
   * must not be given a stale-uniform skip.
   */
  applyLight(current: unknown, revision?: number): ApplyResult {
    const full =
      revision === undefined || revision !== this.lastRevision || current !== this.lastLight;

    const targets = full ? this.materials : this.pending;

    let seen = 0;
    let applied = 0;

    for (const material of targets) {
      ++seen;
      if (material.mapLight !== current && typeof material.setMapLight === 'function') {
        // setMapLight refreshes the uniforms itself.
        material.setMapLight(current);
        ++applied;
      } else if (typeof material.updateLightUniforms === 'function') {
        material.updateLightUniforms();
        ++applied;
      }
    }

    this.pending.clear();
    if (revision !== undefined) {
      this.lastRevision = revision;
      this.lastLight = current;
    }

    return { seen, applied };
  }
}
