import * as THREE from 'three';

/**
 * What to draw WMO surfaces with instead of their own material.
 *
 * The same bisection that settled the invisible character body, pointed at buildings. A WMO's black
 * faces cannot be diagnosed from statistics: averaging MOCV over a group's vertices cannot separate
 * "the data is dark" from "the dark vertices are not the faces you are looking at" -- and on the
 * house that mattered, 1837 of 2016 vertices read below byte 51 while the maximum was exactly 127.
 * Painting the values onto the screen answers it in one glance.
 */
export enum WmoDebugMode {
  /** The real material. */
  Off = 'off',
  /**
   * MOCV straight to the framebuffer, via three's own basic shader.
   *
   * Nothing of ours is in the path: no combiner, no light term, no `mocv * 2`, no fog. What you see
   * IS the vertex colour the loader produced. Mid-grey means a fully lit surface under the shader's
   * doubling; black means the light term has nothing to multiply.
   */
  VertexColor = 'vertexColor',
  /** Flat white, unlit -- proves the geometry and the draw, ignoring both texture and MOCV. */
  Flat = 'flat',
}

/** One placed WMO group, as `WMOGroupView` exposes it. */
interface GroupView {
  mesh?: { material: any; geometry?: any } | null;
}

/** The slice of `WorldMap` this walks: every placed group of every placed WMO. */
export interface WmoDebugMapLike {
  wmoManager?: {
    entries: { forEach(fn: (wmo: { views?: { groups?: Map<number, GroupView> } }) => void): void };
  } | null;
}

/**
 * Swaps WMO group materials for a debug material and puts them back.
 *
 * Walks `wmoManager.entries` rather than the collision registry: the manager is the actual owner of
 * placed group views, and the collision provider indexes the same objects for an unrelated purpose.
 */
export class WmoDebug {
  mode: WmoDebugMode = WmoDebugMode.Off;

  /** Original material per mesh, so the real draw comes back exactly as it was. */
  private originals = new Map<object, any>();

  private vertexColorMaterial: THREE.MeshBasicMaterial | null = null;

  private flatMaterial: THREE.MeshBasicMaterial | null = null;

  /** How many group meshes the last sync had overridden. Read by the panel. */
  overridden = 0;

  private material(mode: WmoDebugMode): THREE.MeshBasicMaterial | null {
    if (mode === WmoDebugMode.VertexColor) {
      if (!this.vertexColorMaterial) {
        this.vertexColorMaterial = new THREE.MeshBasicMaterial({
          vertexColors: true,
          fog: false,
          side: THREE.DoubleSide,
        });
      }
      return this.vertexColorMaterial;
    }

    if (mode === WmoDebugMode.Flat) {
      if (!this.flatMaterial) {
        this.flatMaterial = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          fog: false,
          side: THREE.DoubleSide,
        });
      }
      return this.flatMaterial;
    }

    return null;
  }

  /** Every placed group mesh in the map, in manager order. */
  private meshes(map: WmoDebugMapLike | null): Array<{ material: any; geometry?: any }> {
    const out: Array<{ material: any; geometry?: any }> = [];
    const entries = map?.wmoManager?.entries;

    if (!entries) {
      return out;
    }

    entries.forEach((wmo) => {
      wmo?.views?.groups?.forEach((view) => {
        if (view?.mesh) {
          out.push(view.mesh);
        }
      });
    });

    return out;
  }

  /**
   * Bring the world in line with `mode`. Cheap and idempotent; safe to call every frame, which is
   * what keeps newly streamed groups overridden too.
   */
  sync(map: WmoDebugMapLike | null): void {
    const replacement = this.material(this.mode);

    if (!replacement) {
      for (const [mesh, original] of this.originals) {
        (mesh as any).material = original;
      }
      this.originals.clear();
      this.overridden = 0;
      return;
    }

    let count = 0;

    for (const mesh of this.meshes(map)) {
      if (!this.originals.has(mesh)) {
        this.originals.set(mesh, mesh.material);
      }
      mesh.material = replacement;
      count += 1;
    }

    this.overridden = count;
  }
}

/** The process-wide instance. `World` syncs it; the debug panel sets the mode. */
export const wmoDebug = new WmoDebug();

if (typeof window !== 'undefined') {
  (window as any).wmoDebug = wmoDebug;
}
