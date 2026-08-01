import * as THREE from 'three';
import MapLight from '../../../world/light/MapLight';
import { CloudFrame, CloudKernel, Vec3Like, occ1Sun, occ1Moon } from '../../../world/sky/clouds/kernel';
import { CELESTIAL_DISTANCE } from '../../../world/sky/celestial/laws';
import SkyCone from '../cone';
import CloudDome from '../clouds';
import ProceduralSky from '../procedural';
import Skybox from '../skybox';
import WmoSkybox from '../skybox/wmo';
import SunDisc from '../celestial/sun';
import { Moon02, WhiteMoon } from '../celestial/moons';
import Stars from '../celestial/stars';
import { SunGlare, MoonGlare } from '../celestial/glare';

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

  // Task 6 Step 2: the world's `WMOManager` (duck-typed `any`, same as `skybox/wmo-resolve.ts` --
  // see that file's own doc comment for why). `null` until `setWmoManager` is called at least once,
  // which resolves to "no WMO skybox" the same way an empty `entries` map does.
  private wmoManagerRef: any = null;

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

  // The celestial bodies (celestial-sky plan): the sun disc (Task 2) here, with stars/moons/glare
  // (Tasks 3-5) joining it the same way -- owned here, not swapped by `setMethod`, exactly like the
  // cloud dome above, since the sky bodies sit above whichever gradient/skybox method is active.
  private sunDisc: SunDisc;

  // Task 4: the white moon and moon02, owned the same way as `sunDisc` above -- above whichever
  // gradient/skybox method is active, not swapped by `setMethod`.
  private whiteMoon: WhiteMoon;
  private moon02: Moon02;

  // Task 3: the night-sky stars, owned the same way as `sunDisc`/`whiteMoon`/`moon02` above -- above
  // whichever gradient/skybox method is active, not swapped by `setMethod`.
  private stars: Stars;

  // Task 5: the sun/moon glare -- the cloud coverage field's first consumer. Owned the same way as
  // the other celestial bodies above; renders at +1000 (after the world), unlike everything else on
  // the ladder -- see `glare.ts`'s own module doc.
  private sunGlare: SunGlare;
  private moonGlare: MoonGlare;

  // Task 6 Step 3's suppression rule -- ONE gate over the discrete celestial bodies (plan Risk 3: "six
  // independent checks will drift; one gate will not"). Stars, both discs and both moons live inside
  // this group, and `updateSkyboxSuppression` below is the ONLY place that touches its `.visible`.
  // `skybox` (the legacy method-selectable flat skybox), `sunGlare` and `moonGlare` are deliberately
  // NOT inside it: a skybox replaces this group, and the glare renders outside the sky pass entirely
  // (per the reference; see `glare.ts`'s own module doc) -- gating either of those here would be wrong.
  //
  // The gradient dome and cloud dome used to live in here too, suppressed by the SAME boolean as the
  // bodies -- see `backdropGroup`'s own doc comment for why they were pulled out.
  private celestialGroup: THREE.Group;

  // The gradient/procedural sky (cone OR procedural, whichever `setMethod` last picked) plus the cloud
  // dome -- split out of `celestialGroup` because the two skybox kinds this client draws are NOT
  // equally reliable full replacements for them. The WMO skybox (`MOSB`, a building interior's sealed
  // cube) is: benilla's own capture of `CSky::Render` inside Stratholme's King's Square shows exactly
  // three draws total, the skybox's own texture pairs and nothing else, because the cube has no gaps.
  // The ZONE skybox (`LightSkybox.dbc`) is not: verified against `NagrandSkyBox.m2` (Nagrand, 87
  // batches), its batches are a loose set of small, non-contiguous cloud-layer/ray/stream quads with
  // real gaps between them (confirmed by rendering each batch's raw texture alpha channel directly --
  // solid black gaps between wisp-shaped quads, no batch covering huge stretches of the dome at all).
  // Suppressing this group for the zone skybox the way `celestialGroup` still is left those gaps as
  // literal empty canvas -- transparent pixels a `premultipliedAlpha` canvas composites as the page's
  // white background, not a sky. So `backdropGroup` is hidden only for the WMO skybox; the zone
  // skybox's sparse layers draw ON TOP of it, which is what their gaps were authored expecting.
  private backdropGroup: THREE.Group;

  // Task 6 Step 1: the zone skybox (`LightSkybox.dbc`) -- automatic, driven off `MapLight.
  // lightSkyboxID` every frame, unlike the legacy method-selectable `skybox` above. Owned
  // unconditionally, like the celestial bodies, since it applies regardless of `currentMethod`.
  private zoneSkybox: Skybox;

  // Task 6 Step 2: the WMO skybox (`MOSB`) -- automatic, driven off the camera's portal-flood
  // resolve every frame (see `skybox/wmo-resolve.ts`). Owned unconditionally, same reasoning as
  // `zoneSkybox` above.
  private wmoSkybox: WmoSkybox;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.celestialGroup = new THREE.Group();
    this.celestialGroup.name = 'CelestialGroup';
    this.scene.add(this.celestialGroup);

    this.backdropGroup = new THREE.Group();
    this.backdropGroup.name = 'SkyBackdropGroup';
    this.scene.add(this.backdropGroup);

    this.cloudDome = new CloudDome();
    this.backdropGroup.add(this.cloudDome);

    // First on the plan's draw-order ladder (renderOrder -1003) -- constructed first so the scene
    // graph's own order roughly mirrors the ladder, though renderOrder is what actually decides it.
    this.stars = new Stars();
    this.celestialGroup.add(this.stars);

    this.sunDisc = new SunDisc();
    this.celestialGroup.add(this.sunDisc);

    this.whiteMoon = new WhiteMoon();
    this.celestialGroup.add(this.whiteMoon);

    this.moon02 = new Moon02();
    this.celestialGroup.add(this.moon02);

    // Last on the plan's draw-order ladder (renderOrder +1000, after the world) -- constructed here
    // regardless, since scene-graph insertion order does not decide draw order, only `renderOrder` does.
    // Outside `celestialGroup`: the glare survives a skybox (see the group's own doc comment above).
    this.sunGlare = new SunGlare();
    this.scene.add(this.sunGlare);

    this.moonGlare = new MoonGlare();
    this.scene.add(this.moonGlare);

    this.zoneSkybox = new Skybox();
    this.scene.add(this.zoneSkybox);

    this.wmoSkybox = new WmoSkybox();
    this.scene.add(this.wmoSkybox);
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
    // Task 6 Step 1: the zone skybox reads `MapLight.lightSkyboxID` every frame -- it needs the SAME
    // live reference every other sky object gets, not a one-time hand-off (`WorldMap` swaps in a
    // brand new `MapLight` per zone).
    this.zoneSkybox.setMapLight(mapLight);
  }

  /**
   * Task 6 Step 2: the world's `WMOManager`, forwarded every frame (cheap -- just a reference
   * assignment) so the WMO skybox can re-resolve the flood-reached predicate off the SAME portal-flood
   * visibility flags `VisibilityManager` just set this frame. `null` on a map with no WMOs at all (or
   * before one has loaded), which resolves to "no WMO skybox" exactly like an empty `entries` map does.
   */
  public setWmoManager(wmoManager: any): void {
    this.wmoManagerRef = wmoManager ?? null;
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
      this.backdropGroup.add(this.skyCone);
      console.log('SkyManager: Sky cone added to scene');
    } else if (method === 'procedural') {
      console.log('SkyManager: Creating procedural sky...');
      this.proceduralSky = new ProceduralSky();
      this.proceduralSky.setMapLight(this.mapLight);
      this.backdropGroup.add(this.proceduralSky);
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
      this.backdropGroup.remove(this.skyCone);
      this.skyCone.dispose();
      this.skyCone = null;
    }

    if (this.proceduralSky) {
      this.backdropGroup.remove(this.proceduralSky);
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
    this.updateCelestialBodies(camera, dt);

    // Task 6 Steps 1-2: resolve/build whichever skybox this frame wants. Both are no-ops (stay
    // invisible) when neither the zone nor any WMO names one active right now.
    this.zoneSkybox.update(camera, mapID);
    this.wmoSkybox.update(camera, this.wmoManagerRef);

    // The two backdrops are MUTUALLY EXCLUSIVE, and the WMO one wins. A zone can name a
    // `LightSkybox` while the camera also stands somewhere whose portal flood reaches a group asking
    // for the root's MOSB -- and both are opaque at the same `renderOrder`, so without a tie-break
    // whichever the renderer happens to sort second wins, differently from frame to frame.
    //
    // The building wins because that is what the WMO skybox IS: the sky a building swaps in for the
    // zone's own while you are inside it. Suppressing the zone box is also what makes the celestial
    // suppression below correct either way -- one backdrop, one gate.
    if (this.wmoSkybox.isActive) {
      this.zoneSkybox.visible = false;
    }

    // Task 6 Step 3: the suppression rule, as ONE gate over the whole celestial pass -- see
    // `celestialGroup`'s own doc comment for why this is a single assignment rather than six.
    this.updateSkyboxSuppression();
  }

  /**
   * `CSky::Render` carries one shared boolean and skips ALL SIX element draws together when a skybox
   * is active -- stars, sun disc, both moons, gradient band and cloud dome (plan Task 6 Step 3; a live
   * capture in Stratholme's King's Square shows exactly three draws, the skybox cube's own texture
   * pairs, and nothing else). Only the glare survives, because it renders outside this pass -- see
   * `celestialGroup`'s own doc comment for why `sunGlare`/`moonGlare` are never touched here.
   *
   * That capture was of the WMO skybox (a building interior's `MOSB`) -- a sealed, fully-enclosing
   * cube with no gaps, exactly the kind of thing that can safely stand in for the ENTIRE sky. The
   * zone skybox (`LightSkybox.dbc`) is a different animal: verified against `NagrandSkyBox.m2`, its
   * 87 batches are a loose set of small, non-contiguous cloud-layer/ray/stream quads -- large
   * stretches of the dome have no batch covering them at all (confirmed by rendering each batch's raw
   * texture alpha channel directly: solid black gaps between wisp-shaped quads). Suppressing the
   * gradient dome and cloud dome for THIS case leaves those gaps as literal empty canvas -- transparent
   * pixels that the browser composites as white page background, not a sky. So only the WMO skybox
   * gets the full six-element suppression; the zone skybox suppresses just the discrete bodies (stars,
   * sun, both moons -- still wrong to show a sun disc through cloud wisps that don't occlude it) and
   * leaves the gradient dome + cloud dome as the backdrop its own sparse layers were authored to sit
   * over.
   */
  private updateSkyboxSuppression(): void {
    const suppressed = this.zoneSkybox.isActive || this.wmoSkybox.isActive;
    this.celestialGroup.visible = !suppressed;
    // See `backdropGroup`'s own doc comment: only the WMO skybox (a sealed, gap-free cube) is a full
    // enough replacement to hide the gradient/cloud backdrop. The zone skybox's sparse batches need it
    // showing through their gaps.
    this.backdropGroup.visible = !this.wmoSkybox.isActive;
  }

  /**
   * Task 2 (and the route Tasks 3-5 follow): place/tint every celestial body from the SAME per-frame
   * `MapLight` reference the rest of this manager reads -- no second clock, no second camera-follow.
   * A no-op before `setMapLight` has ever run (matches `updateClouds`'s own null guard). `dt` only
   * matters to the glare's slewed envelope (Task 5); the discs/stars ignore it, same as before.
   */
  private updateCelestialBodies(camera: THREE.Camera, dt: number): void {
    if (!this.mapLight) {
      return;
    }
    this.stars.updateFromLight(camera, this.mapLight);
    this.sunDisc.updateFromLight(camera, this.mapLight);
    this.whiteMoon.updateFromLight(camera, this.mapLight);
    this.moon02.updateFromLight(camera, this.mapLight);
    this.updateGlare(camera, dt);
  }

  /**
   * Task 5: the sun/moon glare. Samples the SAME `cloudKernel` instance the cloud dome renders from
   * (plan Risk 5 -- a second field would dim the flare for clouds nobody can see) at each body's
   * 12-unit sky point (`laws.CELESTIAL_DISTANCE`, the glare's own near-sphere placement -- the
   * kernel's `coverage(d)` is not scale-invariant, so this offset must match the point the glare
   * actually sits at, not a bare unit direction). `interior` stands in for the reference's terrain/
   * interior occlusion gate -- see `glare.ts`'s module doc for why only the interior half is ported.
   */
  private updateGlare(camera: THREE.Camera, dt: number): void {
    const mapLight = this.mapLight;
    if (!mapLight) {
      return;
    }

    const interior = mapLight.location === 'interior';

    const sunDir = mapLight.celestialSunDir;
    const sunPoint: Vec3Like = {
      x: sunDir.x * CELESTIAL_DISTANCE,
      y: sunDir.y * CELESTIAL_DISTANCE,
      z: sunDir.z * CELESTIAL_DISTANCE,
    };
    const sunOcc1 = occ1Sun(this.cloudKernel.coverage(sunPoint));

    const moonDir = mapLight.moonDir;
    const moonPoint: Vec3Like = {
      x: moonDir.x * CELESTIAL_DISTANCE,
      y: moonDir.y * CELESTIAL_DISTANCE,
      z: moonDir.z * CELESTIAL_DISTANCE,
    };
    const moonOcc1 = occ1Moon(this.cloudKernel.coverage(moonPoint));

    this.sunGlare.updateFromLight(camera, mapLight, sunOcc1, interior, dt);
    this.moonGlare.updateFromLight(camera, mapLight, moonOcc1, interior, dt);
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

    this.celestialGroup.visible = enabled;
    this.backdropGroup.visible = enabled;

    if (this.skybox) {
      this.skybox.visible = enabled;
    }

    this.zoneSkybox.visible = enabled;
    this.wmoSkybox.visible = enabled;

    // The glare lives OUTSIDE `celestialGroup` on purpose -- it renders after the world, so a skybox
    // must not suppress it (see `updateSkyboxSuppression`). But "the skybox hides it" and "the user
    // turned the sky off" are different questions, and hiding the group answered only the first.
    // Because `update()` early-returns while disabled, the two flare quads kept their last resolved
    // tint, scale and position and simply hung in the sky, frozen, after the sky was switched off.
    this.sunGlare.visible = enabled;
    this.moonGlare.visible = enabled;
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
    this.backdropGroup.remove(this.cloudDome);
    this.cloudDome.dispose();
    this.celestialGroup.remove(this.stars);
    this.stars.dispose();
    this.celestialGroup.remove(this.sunDisc);
    this.sunDisc.dispose();
    this.celestialGroup.remove(this.whiteMoon);
    this.whiteMoon.dispose();
    this.celestialGroup.remove(this.moon02);
    this.moon02.dispose();
    this.scene.remove(this.celestialGroup);
    this.scene.remove(this.backdropGroup);
    this.scene.remove(this.sunGlare);
    this.sunGlare.dispose();
    this.scene.remove(this.moonGlare);
    this.moonGlare.dispose();
    this.scene.remove(this.zoneSkybox);
    this.zoneSkybox.dispose();
    this.scene.remove(this.wmoSkybox);
    this.wmoSkybox.dispose();
  }
}

export default SkyManager;
