import * as THREE from 'three';
import MapLight from '../../../world/light/MapLight';
import SkyCone from '../cone';
import ProceduralSky from '../procedural';
import Skybox from '../skybox';

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

  constructor(scene: THREE.Scene) {
    this.scene = scene;
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
   * Updates the sky system
   */
  public update(camera: THREE.Camera, mapID: number): void {
    if (!this.isEnabled) return;

    if (this.currentMethod === 'cone' && this.skyCone) {
      this.skyCone.update(camera, mapID);
    } else if (this.currentMethod === 'procedural' && this.proceduralSky) {
      this.proceduralSky.update(camera, mapID);
    } else if (this.currentMethod === 'skybox' && this.skybox) {
      this.skybox.update(camera, mapID);
    }
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
  }
}

export default SkyManager;
