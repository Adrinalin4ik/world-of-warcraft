import * as THREE from 'three';
import MapLight from '../../../world/light/MapLight';
import { CloudFrame, CloudKernel, Vec3Like } from '../../../world/sky/clouds/kernel';
import SkyCone from '../cone';
import CloudDome from '../clouds';
import ProceduralSky from '../procedural';
import Skybox from '../skybox';

/** Task 6's instrument bundle -- the numbers that distinguish "the field is empty" from "the field
 * is fine and the dome is not drawing" (see the plan's own framing). `null` before the kernel has
 * ever been primed (no `MapLight` yet). */
export type CloudReadout = {
  /** The resolved `C` the tile was last built/ticked with. */
  density: number;
  /** The kernel's noise-space phase (u16). */
  phase: number;
  /** The tile row the next band starts at. */
  scroll: number;
  /** The mean byte across the whole coverage tile, 0..255 -- non-zero means the field is alive. */
  tileMean: number;
  /** `coverage()` sampled toward the current glow body direction, 0..1 -- agrees with `tileMean`
   * only if the sampler and the field are in sync. */
  sampledCoverage: number;
};

/**
 * Sky Manager
 *
 * Manages sky rendering using either the Blizzard method (sky cone) or
 * procedural method (sphere with elevation-based color interpolation).
 */
class SkyManager {
  private scene: THREE.Scene;
  private skyCone: SkyCone | null = null;
  private proceduralSky: ProceduralSky | null = null;
  private skybox: Skybox | null = null;
  private currentMethod: 'cone' | 'procedural' | 'skybox' = 'cone';
  private isEnabled: boolean = true;

  // Task 4: the current sky object needs the same `MapLight` reference the rest of the world uses,
  // to read the published sky-dome bands off it. Held here (rather than only handed once) because
  // `setMethod` can swap the active sky object out from under a caller that already called
  // `setMapLight` once -- the freshly created object needs it too.
  private mapLight: MapLight | null = null;

  // Procedural clouds (Task 6): the coverage kernel and the visible dome that renders its bytes.
  // Owned here (not swapped by `setMethod`) because clouds sit above whichever sky-gradient method
  // is active, exactly like `MapLight` itself is not tied to the render method.
  private cloudKernel = new CloudKernel();
  private cloudDome: CloudDome;
  // Whether the kernel has ever been fully rebuilt -- distinct from the kernel's OWN ~10 Hz
  // countdown (its `tick()`/`rebuild()` own that timer; this is just "have we primed yet / did the
  // zone change", not a second clock).
  private cloudPrimed = false;
  // Identity of the `MapLight` the kernel was last driven from -- `WorldMap` constructs a brand new
  // `MapLight` per zone (`map.js`'s `changeMap`), so a reference change IS a zone change and forces
  // a full rebuild instead of an incremental tick.
  private lastCloudMapLight: MapLight | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.cloudDome = new CloudDome();
    this.scene.add(this.cloudDome);
  }

  /**
   * Forward the world's `MapLight` to whichever sky object is currently active, and remember it so a
   * later `setMethod` call can hand it to the NEXT sky object too. See `ProceduralSky.setMapLight` for
   * what happens when this is null (the "no MapLight reference at all" fallback, distinct from the
   * DBC-missing fallback `MapLight` itself already has).
   */
  public setMapLight(mapLight: MapLight | null): void {
    this.mapLight = mapLight;
    (this.getCurrentSky() as any)?.setMapLight?.(mapLight);
  }

  /**
   * Initializes the sky system with the specified method
   */
  public initialize(method: 'cone' | 'procedural' | 'skybox' = 'cone'): void {
    this.setMethod(method);
  }

  /**
   * Sets the sky rendering method
   */
  public setMethod(method: 'cone' | 'procedural' | 'skybox'): void {
    if (this.currentMethod === method) return;

    console.log(`SkyManager: Setting method to ${method}`);

    // Remove current sky
    this.removeCurrentSky();

    this.currentMethod = method;

    // Create new sky based on method
    if (method === 'cone') {
      console.log('SkyManager: Creating sky cone...');
      this.skyCone = new SkyCone();
      this.scene.add(this.skyCone);
      console.log('SkyManager: Sky cone added to scene');
    } else if (method === 'procedural') {
      console.log('SkyManager: Creating procedural sky...');
      this.proceduralSky = new ProceduralSky();
      this.proceduralSky.setMapLight(this.mapLight);
      this.scene.add(this.proceduralSky);
      console.log('SkyManager: Procedural sky added to scene');
    } else if (method === 'skybox') {
      console.log('SkyManager: Creating skybox...');
      this.skybox = new Skybox();
      this.scene.add(this.skybox);
      console.log('SkyManager: Skybox added to scene');
    }
  }

  /**
   * Removes the current sky from the scene
   */
  private removeCurrentSky(): void {
    if (this.skyCone) {
      this.scene.remove(this.skyCone);
      this.skyCone.dispose();
      this.skyCone = null;
    }
    
    if (this.proceduralSky) {
      this.scene.remove(this.proceduralSky);
      this.proceduralSky.dispose();
      this.proceduralSky = null;
    }
    
    if (this.skybox) {
      this.scene.remove(this.skybox);
      this.skybox.dispose();
      this.skybox = null;
    }
  }

  /**
   * Updates the sky system.
   *
   * `dt` is Task 6's wiring: the SAME per-frame delta that already drives the fog ramp and the
   * weather channels (`World.animate`'s `delta`, itself `THREE.Clock.getDelta()`) -- not a second
   * clock. Optional/defaulted to 0 so existing call sites and tests that only pass
   * `(camera, mapID)` keep compiling; a caller that omits it simply never advances the incremental
   * scroll (harmless -- a rebuild still runs the first time a `MapLight` is seen).
   */
  public update(camera: THREE.Camera, mapID: number, dt: number = 0): void {
    if (!this.isEnabled) return;

    if (this.currentMethod === 'cone' && this.skyCone) {
      this.skyCone.update(camera, mapID);
    } else if (this.currentMethod === 'procedural' && this.proceduralSky) {
      this.proceduralSky.update(camera, mapID);
    } else if (this.currentMethod === 'skybox' && this.skybox) {
      this.skybox.update(camera, mapID);
    }

    this.updateClouds(camera, dt);
  }

  /**
   * Task 6: advance the shared coverage field and re-upload the dome's texture when it changed.
   * Runs regardless of `currentMethod` -- the clouds sit above whichever sky-gradient dome is
   * active, same as `MapLight` itself.
   */
  private updateClouds(camera: THREE.Camera, dt: number): void {
    // Camera-follow runs every frame independent of whether the field itself changed.
    this.cloudDome.update(camera);

    const mapLight = this.mapLight;
    if (!mapLight) {
      return;
    }

    // Full rebuild on the first frame we ever see a `MapLight`, and again whenever it is a DIFFERENT
    // instance (a zone change) -- the reference's own init-vs-scroll distinction. Everything else
    // rides the kernel's own ~10 Hz self-throttled `tick()`.
    const zoneChanged = mapLight !== this.lastCloudMapLight;
    this.lastCloudMapLight = mapLight;

    const frame: CloudFrame = {
      sun: [mapLight.cloudSunColor.r, mapLight.cloudSunColor.g, mapLight.cloudSunColor.b],
      slope: [mapLight.cloudSlopeColor.r, mapLight.cloudSlopeColor.g, mapLight.cloudSlopeColor.b],
      gbase: [mapLight.cloudBaseColor.r, mapLight.cloudBaseColor.g, mapLight.cloudBaseColor.b],
      bcc: mapLight.stormBlend,
      glowDir: {
        x: mapLight.cloudGlowDir.x,
        y: mapLight.cloudGlowDir.y,
        z: mapLight.cloudGlowDir.z,
      },
      glowTrack: mapLight.cloudGlowTrack,
    };

    let changed: boolean;
    if (!this.cloudPrimed || zoneChanged) {
      this.cloudPrimed = true;
      this.cloudKernel.rebuild(mapLight.cloudDensity, frame);
      changed = true;
    } else {
      changed = this.cloudKernel.tick(dt, mapLight.cloudDensity, frame);
    }

    this.cloudDome.setCoverageTexture(this.cloudKernel.rgba(), changed);
  }

  /**
   * The shared coverage field's sampler (plan's "the architecture" section) -- for the glare/flare
   * pass that does not exist yet in this client. Returns 0 (no occlusion) before the kernel has ever
   * been primed, matching an all-clear sky.
   */
  public cloudCoverage(d: Vec3Like): number {
    return this.cloudPrimed ? this.cloudKernel.coverage(d) : 0;
  }

  /**
   * Task 6's instruments: resolved `C`, phase, scroll row, tile mean, and `coverage()` sampled
   * toward the glow body -- the mean and the sampled coverage are what distinguish "the field is
   * empty" from "the field is fine and the dome is not drawing". `null` before the kernel has ever
   * been primed.
   */
  public getCloudReadout(): CloudReadout | null {
    if (!this.cloudPrimed || !this.lastCloudMapLight) {
      return null;
    }

    const tile = this.cloudKernel.tile();
    let sum = 0;
    for (let i = 0; i < tile.length; i++) {
      sum += tile[i];
    }
    const tileMean = sum / tile.length;

    const glowDir = this.lastCloudMapLight.cloudGlowDir;
    const sampledCoverage = this.cloudKernel.coverage({ x: glowDir.x, y: glowDir.y, z: glowDir.z });

    return {
      density: this.lastCloudMapLight.cloudDensity,
      phase: this.cloudKernel.phase(),
      scroll: this.cloudKernel.scroll(),
      tileMean,
      sampledCoverage,
    };
  }

  /**
   * Enables or disables sky rendering
   */
  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    
    if (this.skyCone) {
      this.skyCone.visible = enabled;
    }
    
    if (this.proceduralSky) {
      this.proceduralSky.visible = enabled;
    }
    
    if (this.skybox) {
      this.skybox.visible = enabled;
    }
  }

  /**
   * Gets the current sky rendering method
   */
  public getMethod(): 'cone' | 'procedural' | 'skybox' {
    return this.currentMethod;
  }

  /**
   * Gets whether sky rendering is enabled
   */
  public isSkyEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Gets the current sky object for debugging
   */
  public getCurrentSky(): THREE.Object3D | null {
    if (this.currentMethod === 'cone') {
      return this.skyCone;
    } else if (this.currentMethod === 'procedural') {
      return this.proceduralSky;
    } else if (this.currentMethod === 'skybox') {
      return this.skybox;
    }
    return null;
  }

  /**
   * Disposes of the sky manager and all sky objects
   */
  public dispose(): void {
    this.removeCurrentSky();
    this.scene.remove(this.cloudDome);
    this.cloudDome.dispose();
  }
}

export default SkyManager;
