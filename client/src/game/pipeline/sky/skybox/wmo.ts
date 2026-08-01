import * as THREE from 'three';
import { buildSkyboxMeshes, disposeSkyboxMesh, loadSkyboxBatches, SkyboxBatch, updateSkyboxAnimatedAlpha } from './model';
import { resolveActiveWmoSkybox } from './wmo-resolve';

/**
 * The WMO skybox (celestial-sky plan, Task 6 Step 2, `MOSB`) -- the painted sky a building swaps in for
 * the gradient dome while the camera's portal flood reaches a `SHOW_SKYBOX` group. See
 * `./wmo-resolve.ts` for the flood-reached predicate itself; this class only builds/shows the model
 * that predicate names.
 *
 * Built once per path and kept for the session rather than torn down on leaving the room -- walking in
 * and out of Stratholme's gate must not re-decode the model every time (benilla `wmo_sky.rs`'s own
 * `BuiltSkyboxes` cache, ported here as `this.built`).
 */

const WMO_SKYBOX_RENDER_ORDER = -1000;

type BuiltSkybox = {
  group: THREE.Group;
  loading: boolean;
  /** `true` once the load has settled (success OR failure) -- a failed path is not retried every
   * frame, and the gradient dome stays the correct fallback for it (mirrors benilla's own
   * `BuiltSkyboxes`, which records a failed path too). */
  settled: boolean;
  /** This entry's own meshes (empty until the load settles) -- kept off `group.children` so
   * `updateSkyboxAnimatedAlpha` doesn't have to filter out a possible future non-mesh child. */
  meshes: THREE.Mesh[];
  /** Wall-clock ms (`Date.now()`) this entry's `buildAndCache` call started -- the free-running clock
   * its batches' global-sequence alpha tracks loop against (`model.ts`'s own module doc, point 2). */
  loadedAtMs: number;
};

class WmoSkybox extends THREE.Group {
  private built = new Map<string, BuiltSkybox>();

  private activePath: string | null = null;

  private disposedFlag = false;

  constructor() {
    super();
    this.name = 'WmoSkybox';
    this.matrixAutoUpdate = false;
  }

  /** Whether a WMO skybox is currently the resolved backdrop -- Task 6 Step 3's suppression gate reads
   * this the same way it reads the zone `Skybox.isActive`. */
  public get isActive(): boolean {
    return !!this.activePath;
  }

  /**
   * Per-frame: camera-anchor this whole group (world-aligned, identity rotation -- same treatment
   * `Skybox` and `Stars` give their own camera-anchored shells), resolve which path (if any) the
   * camera's WMO portal flood currently wants, build it on first need, and show exactly that one.
   */
  public update(camera: THREE.Camera, wmoManager: any): void {
    this.position.copy(camera.position);
    this.rotation.set(0, 0, 0);
    this.updateMatrix();
    this.updateMatrixWorld(true);

    const path = resolveActiveWmoSkybox(wmoManager);
    this.activePath = path;

    for (const [entryPath, entry] of this.built) {
      entry.group.visible = entryPath === path;
    }

    if (path && !this.built.has(path)) {
      this.buildAndCache(path);
    }

    for (const entry of this.built.values()) {
      if (entry.meshes.length > 0) {
        updateSkyboxAnimatedAlpha(entry.meshes, Date.now() - entry.loadedAtMs);
      }
    }
  }

  private buildAndCache(path: string): void {
    const group = new THREE.Group();
    this.add(group);
    const entry: BuiltSkybox = { group, loading: true, settled: false, meshes: [], loadedAtMs: Date.now() };
    this.built.set(path, entry);

    loadSkyboxBatches(path)
      .then((batches: SkyboxBatch[]) => {
        entry.loading = false;
        entry.settled = true;
        if (this.disposedFlag) {
          return;
        }
        if (batches.length === 0) {
          console.warn(`WmoSkybox: '${path}' decoded to zero usable batches -- keeping the gradient dome`);
          return;
        }
        entry.loadedAtMs = Date.now();
        const meshes = buildSkyboxMeshes(batches, WMO_SKYBOX_RENDER_ORDER);
        for (const mesh of meshes) {
          group.add(mesh);
        }
        entry.meshes = meshes;
        // Only the currently-resolved path should be visible; a build that settles after the camera
        // already moved on must not pop a stale skybox onto the screen.
        group.visible = this.activePath === path;
      })
      .catch((error: unknown) => {
        entry.loading = false;
        entry.settled = true;
        console.error(`WmoSkybox: failed to load '${path}', keeping the gradient dome:`, error);
      });
  }

  public dispose(): void {
    this.disposedFlag = true;
    for (const entry of this.built.values()) {
      for (const mesh of entry.meshes) {
        disposeSkyboxMesh(mesh);
      }
    }
    this.built.clear();
  }
}

export default WmoSkybox;
