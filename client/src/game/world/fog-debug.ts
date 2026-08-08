/**
 * Global fog kill switch, for taking fog out of the picture while diagnosing something else.
 *
 * Every fogged material in this client -- M2, WMO and terrain alike -- reads the same `fogParams`
 * vec4 and the same ramp: `f1 = distance * x + y`, `factor = 1 - clamp(f1, 0, 1)` (times each
 * shader's own modifier). So `x = 0, y = 1` pins `f1` at 1 and the factor at ZERO for all of them,
 * with one uniform and no shader changes, no defines and no recompiles.
 *
 * Nothing needs restoring. `MaterialRegistry.applyLight` re-copies `fogParams` from `MapLight` every
 * frame, so switching this off simply stops overwriting it and the real ramp is back on the next
 * frame.
 */

import { loadPref, savePref } from './debug-prefs';

/** A material carrying the fog uniforms. Structural: the three families share these names. */
interface FoggedMaterial {
  uniforms?: {
    fogParams?: { value?: { set?(x: number, y: number, z: number, w: number): void } };
    wmoFogParams?: { value?: { set?(x: number, y: number, z: number, w: number): void } };
  };
}

export interface FogDebugMapLike {
  materialRegistry?: { forEach(fn: (material: FoggedMaterial) => void): void } | null;
}

export class FogDebug {
  // Annotated: `loadPref`'s generic would otherwise infer the LITERAL `false` from the fallback and
  // the setter could never store true.
  private _disabled: boolean = loadPref('fogOff', false);

  /** Persisted: a switch that reset on reload made the comparison it exists for impossible to hold. */
  get disabled(): boolean {
    return this._disabled;
  }

  set disabled(value: boolean) {
    this._disabled = value;
    savePref('fogOff', value);
  }

  /** Materials neutralised on the last sync. Read by the panel, so a no-op toggle is visible. */
  applied = 0;

  /**
   * Must run AFTER the per-frame light pass, or the light pass overwrites the neutral values again
   * and the switch appears to do nothing.
   */
  sync(map: FogDebugMapLike | null): void {
    if (!this.disabled) {
      this.applied = 0;
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

      let touched = false;

      // The interior triple too: a camera inside a WMO room takes `wmoFogParams` instead, so leaving
      // it alone would keep fogging exactly the interiors this is most often used to inspect.
      for (const slot of [uniforms.fogParams, uniforms.wmoFogParams]) {
        if (slot?.value?.set) {
          slot.value.set(0, 1, 1, 1);
          touched = true;
        }
      }

      if (touched) {
        count += 1;
      }
    });

    this.applied = count;
  }
}

/** The process-wide instance. `World` syncs it; the debug panel flips it. */
export const fogDebug = new FogDebug();

if (typeof window !== 'undefined') {
  (window as any).fogDebug = fogDebug;
}
