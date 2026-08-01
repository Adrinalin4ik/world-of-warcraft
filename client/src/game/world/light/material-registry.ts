/** The light-binding surface a material may implement. All members are optional. */
export interface LightBoundMaterial {
  mapLight?: unknown;
  setMapLight?(light: unknown): void;
  updateLightUniforms?(): void;
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

  get size(): number {
    return this.materials.size;
  }

  add(material: LightBoundMaterial | null | undefined): void {
    if (material) {
      this.materials.add(material);
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

  clear(): void {
    this.materials.clear();
  }

  applyLight(current: unknown): ApplyResult {
    let seen = 0;
    let applied = 0;

    for (const material of this.materials) {
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

    return { seen, applied };
  }
}
