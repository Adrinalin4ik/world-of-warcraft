/**
 * Global scene-lighting kill switch: draw every surface at its own albedo, unlit.
 *
 * Two uniforms, because the three families do not share one switch:
 *
 *   `lightModifier`      -- WMO takes its UNLIT branch at <= 0 (`tex x wmoBrightness`, which skips
 *                           MOCV as well), and terrain skips its light block entirely at <= 0.
 *   `materialParams.y`   -- M2's only switch: `light = mix(light, vec3(1.0), 1.0 - y)`, so 0 pins the
 *                           light term to white. Terrain reads the same mix, so it is covered twice
 *                           over; M2's own `lightModifier` is declared but never read.
 *
 * Unlike fog, these are NOT re-copied by the per-frame light pass -- `materialParams` is set once at
 * construction and `lightModifier` by `applyRenderFlags` -- so the originals are stashed and put back
 * verbatim. That matters: a batch carrying the M2 unlit render flag (0x01) legitimately has y = 0
 * already, and restoring a blanket 1.0 would silently light geometry the format says must not be.
 */

import { loadPref, savePref } from './debug-prefs';

interface LitMaterial {
  uniforms?: {
    lightModifier?: { value?: unknown };
    materialParams?: { value?: unknown };
  };
}

export interface LightDebugMapLike {
  materialRegistry?: { forEach(fn: (material: LitMaterial) => void): void } | null;
}

interface Saved {
  lightModifier?: unknown;
  materialParamsY?: number;
}

export class LightDebug {
  // Annotated for the same reason as FogDebug's: the fallback would pin the type to literal `false`.
  private _disabled: boolean = loadPref('lightOff', false);

  /** Persisted, same reason as the fog switch: a reload must not lose the comparison. */
  get disabled(): boolean {
    return this._disabled;
  }

  set disabled(value: boolean) {
    this._disabled = value;
    savePref('lightOff', value);
  }

  /** Materials neutralised on the last sync, so a switch that reached nothing is visible. */
  applied = 0;

  private saved = new Map<LitMaterial, Saved>();

  sync(map: LightDebugMapLike | null): void {
    if (!this.disabled) {
      this.restore();
      return;
    }

    const registry = map?.materialRegistry;
    if (!registry) {
      this.applied = 0;
      return;
    }

    let count = 0;

    registry.forEach((material) => {
      const uniforms = material?.uniforms;
      if (!uniforms) {
        return;
      }

      if (!this.saved.has(material)) {
        const stash: Saved = {};

        if (uniforms.lightModifier) {
          stash.lightModifier = uniforms.lightModifier.value;
        }

        const params = uniforms.materialParams?.value;
        if (Array.isArray(params)) {
          stash.materialParamsY = params[1];
        }

        this.saved.set(material, stash);
      }

      let touched = false;

      if (uniforms.lightModifier) {
        uniforms.lightModifier.value = 0.0;
        touched = true;
      }

      const params = uniforms.materialParams?.value;
      if (Array.isArray(params)) {
        params[1] = 0.0;
        touched = true;
      }

      if (touched) {
        count += 1;
      }
    });

    this.applied = count;
  }

  /**
   * Put every stashed value back.
   *
   * Iterates what was STASHED rather than the registry: a material can leave the registry on a map
   * change while still being referenced by live geometry, and it would otherwise stay unlit forever.
   */
  private restore(): void {
    for (const [material, stash] of this.saved) {
      const uniforms = material.uniforms;
      if (!uniforms) {
        continue;
      }

      if (uniforms.lightModifier && 'lightModifier' in stash) {
        uniforms.lightModifier.value = stash.lightModifier;
      }

      const params = uniforms.materialParams?.value;
      if (Array.isArray(params) && stash.materialParamsY !== undefined) {
        params[1] = stash.materialParamsY;
      }
    }

    this.saved.clear();
    this.applied = 0;
  }
}

/** The process-wide instance. `World` syncs it; the debug panel flips it. */
export const lightDebug = new LightDebug();

if (typeof window !== 'undefined') {
  (window as any).lightDebug = lightDebug;
}
