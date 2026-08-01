import * as THREE from 'three';
import MapLight from '../../../world/light/MapLight';
import DBC from '../../dbc';
import TextureLoader from '../../texture-loader';
import { buildSkyboxMeshes, loadSkyboxBatches } from './model';

/**
 * The zone skybox (celestial-sky plan, Task 6 Step 1): `LightParams.lightSkyboxID` -> `LightSkybox.dbc`
 * -> an M2 this zone draws in place of the gradient dome. `MapLight` already resolves the id with a
 * nearest-wins pick (see `blendLights`' doc comment on `lightSkyboxID`); this class's whole job is
 * turning that id into a model on screen.
 *
 * ## Why this no longer builds a cube texture
 *
 * The previous implementation of this file read `LightSkybox.dbc`'s `file` field and (when it got past
 * its own "texture loading disabled for debugging" stub at all) tried to treat it as a set of static
 * face colours/textures for a `THREE.CubeTexture`. That is not what the field names: `LightSkybox.dbc`
 * names an **M2 model** (the reference's own `CM2Model` skybox, per benilla `wmo_sky.rs`'s module doc,
 * which documents the SAME "draw the model as authored, camera-anchored, identity rotation" treatment
 * for the sibling WMO-skybox feature), not six flat cube faces. Building a cube texture from it was
 * building the wrong artifact from the right field. This class now decodes and draws the real M2
 * instead of approximating it as a skybox cube -- see `./model.ts` for the shared M2 decode (also used
 * by the WMO skybox, `./wmo.ts`) and `stars.ts`'s own module doc for why that decode bypasses
 * `M2ManagerLite` entirely.
 */

const ZONE_SKYBOX_RENDER_ORDER = -1000;

class Skybox extends THREE.Group {
  private mapLight: MapLight | null = null;

  // The `LightSkybox.dbc` id this instance is currently showing a model for, or `null` before any
  // resolve has run. Distinct from `0` (a resolved "no skybox" state) so the first frame -- before
  // `MapLight` has ever published anything -- doesn't look identical to "this zone explicitly has none".
  private currentID: number | null = null;

  private meshes: THREE.Mesh[] = [];

  // Bumped on every id change so a load that resolves after a LATER id change (a fast zone swap, or a
  // dev hot-reload) discards its result instead of replacing a newer skybox with a stale one.
  private generation = 0;

  private disposedFlag = false;

  // Set when the CURRENT id definitively cannot be drawn: the DBC row names nothing, the model 404s,
  // or it decodes to zero usable batches. Cleared on every id change, so a later zone gets a fresh
  // attempt. See `isActive` for why this exists at all.
  private failed = false;

  constructor() {
    super();
    this.name = 'Skybox';
    this.matrixAutoUpdate = false;
  }

  /**
   * Whether this zone has a skybox that can actually be drawn -- Task 6 Step 3's suppression gate
   * reads this (with the WMO skybox's own `isActive`) to decide whether to hide the rest of the
   * celestial pass.
   *
   * Deliberately NOT gated on the published id alone. It was, on the reasoning that a slow-loading
   * model should still suppress the dome the instant the zone data says so -- true, and the reason
   * `failed` is separate from "still loading". But the reference has no async load precisely because
   * its model cannot 404, and ours can: Nagrand's `LightSkybox` row names an `.mdx` path, so every
   * load failed, and a skybox drawing NOTHING went on suppressing the gradient dome, the clouds, the
   * stars and both discs. The whole sky rendered as the bare clear colour.
   *
   * So: suppress while loading (no flash of gradient dome on a zone change), and stop suppressing the
   * moment we know this id cannot draw. A zone whose skybox is missing falls back to the sky it would
   * have had, which is strictly better than a blank one.
   */
  public get isActive(): boolean {
    return !!this.currentID && !this.failed;
  }

  public setMapLight(mapLight: MapLight | null): void {
    this.mapLight = mapLight;
  }

  public update(camera: THREE.Camera, _mapID: number): void {
    // World-aligned, camera-anchored, identity rotation -- the same treatment the WMO skybox and
    // `Stars` give their own camera-anchored shells (benilla `wmo_sky.rs::follow_camera`'s own doc:
    // the model's local origin sits exactly at the eye).
    this.position.copy(camera.position);
    this.rotation.set(0, 0, 0);
    this.updateMatrix();
    this.updateMatrixWorld(true);

    const id = this.mapLight?.lightSkyboxID ?? 0;
    if (id !== this.currentID) {
      this.currentID = id;
      this.resolveAndLoad(id);
    }
  }

  private clearMeshes(): void {
    for (const mesh of this.meshes) {
      this.remove(mesh);
      mesh.geometry.dispose();
      const material = mesh.material as THREE.MeshBasicMaterial;
      const map = material.map;
      material.dispose();
      // The shared PLACEHOLDER texture (model.ts's initial map) is never refcounted by TextureLoader
      // and must not be handed back to it -- only a texture that actually resolved through
      // `TextureLoader.load` owns a refcount to release.
      if (map && map !== TextureLoader.PLACEHOLDER) {
        TextureLoader.unload(map);
      }
    }
    this.meshes = [];
  }

  private async resolveAndLoad(id: number): Promise<void> {
    const myGeneration = ++this.generation;

    this.clearMeshes();
    // A fresh attempt for a new id: suppress again while it loads (see `isActive`).
    this.failed = false;

    if (!id) {
      return;
    }

    let path: string | null = null;
    try {
      const record = await DBC.load('LightSkybox', id);
      path = record?.file ? String(record.file).replace(/\0.*$/, '').trim() : null;
    } catch (error) {
      console.error(`Skybox: failed to load LightSkybox.dbc row ${id}:`, error);
    }

    if (!path) {
      console.warn(`Skybox: LightSkybox.dbc row ${id} names no model -- keeping the gradient dome`);
      this.failed = true;
      return;
    }

    // LightSkybox.dbc stores the authoring-time extension, not the shipped one: every row names a
    // `.mdx` (Warcraft III's model extension, which the WoW toolchain kept in the DBCs), while the
    // file in the data chain is `.m2`. Nagrand's row 12 is `Environments\Stars\NagrandSkyBox.mdx`,
    // and asking the asset host for that returns 404 for every skybox zone in the game.
    path = path.replace(/\.(mdx|mdl)$/i, '.m2');

    if (this.disposedFlag || myGeneration !== this.generation) {
      return;
    }

    let batches;
    try {
      batches = await loadSkyboxBatches(path);
    } catch (error) {
      console.error(`Skybox: failed to load zone skybox model '${path}':`, error);
      this.failed = true;
      return;
    }

    if (this.disposedFlag || myGeneration !== this.generation) {
      return;
    }

    if (batches.length === 0) {
      console.warn(`Skybox: zone skybox model '${path}' decoded to zero usable batches -- keeping the gradient dome`);
      this.failed = true;
      return;
    }

    const meshes = buildSkyboxMeshes(batches, ZONE_SKYBOX_RENDER_ORDER);
    for (const mesh of meshes) {
      this.add(mesh);
    }
    this.meshes = meshes;
  }

  public dispose(): void {
    this.disposedFlag = true;
    this.clearMeshes();
  }
}

export default Skybox;
