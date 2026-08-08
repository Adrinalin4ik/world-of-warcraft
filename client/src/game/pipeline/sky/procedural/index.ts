import * as THREE from 'three';
import MapLight from '../../../world/light/MapLight';

/**
 * Procedural Sky dome (Task 4 of the lightparams-weather-sky plan) -- the sky-dome half of the plan's
 * "authored bands" work. Publishes/consumes:
 *
 *  - The five authored `Light.dbc` sky-gradient stops (`LIGHT_INT_BAND` rows 2-6, `MapLight`'s
 *    `skyTopColor`/`skyMiddleColor`/`skyBand1Color`/`skyBand2Color`/`skySmogColor`), interpolated
 *    per-fragment by view-direction elevation.
 *  - Row 7 (`MapLight#fogColor`) as the horizon colour the gradient converges into.
 *  - `MapLight#skyWarp` (`laws.skyWarp`) and `#sunAzimuth` for the dawn/dusk azimuthal warp.
 *
 * Geometry/elevation mapping ported from `samples/benilla/crates/benilla/assets/shaders/sky.wgsl` +
 * `crates/benilla/src/sky.rs`'s own doc comments (WoW.exe `FUN_006d0d10`/`FUN_006d0f50`,
 * apitrace-cross-checked): one stop per GEOMETRIC elevation above the horizon -- SkyColor0 (zenith) @
 * 90 deg, SkyColor1 @ 16.8 deg, SkyColor2 @ 9.8 deg, SkyColor3 @ 3.7 deg, SkyColor4 @ 1.8 deg, and the
 * horizon (0 deg) and below = the fog colour. Reproduced here as a camera-centred sphere with the
 * gradient evaluated per-fragment from the view direction (tessellation-independent), same as benilla's
 * own dome -- rather than per-vertex like the real 1.12.1 client's cone, which this client's sibling
 * `SkyCone` targets instead (see `SkyManager`).
 *
 * This client is Z-up (`camera.up = (0, 0, 1)`, and `MapLight#sunDir`'s own spherical convention agrees
 * -- `z = cos(phi)`), so "elevation" reads off `dir.z`, not `dir.y` as benilla's Y-up world does; and
 * the azimuthal warp's horizontal plane is XY, not XZ. Both axis choices are noted where they matter
 * below rather than silently inherited from the reference's Y-up convention.
 */
class ProceduralSky extends THREE.Mesh {
  private uniforms: {
    skyTop: { value: THREE.Color };
    skyMiddle: { value: THREE.Color };
    skyBand1: { value: THREE.Color };
    skyBand2: { value: THREE.Color };
    skySmog: { value: THREE.Color };
    skyFog: { value: THREE.Color };
    warpStrength: { value: number };
    sunAzimuth: { value: number };
    useFallback: { value: number };
  };

  private mapLight: MapLight | null = null;

  constructor() {
    super();
    this.name = 'ProceduralSky';

    this.createGeometry();
    this.createMaterial();

    this.position.set(0, 0, 0);
    this.frustumCulled = false; // Always render regardless of camera position
    this.renderOrder = -1000; // Render before everything else
  }

  /**
   * A unit sphere, scaled to the camera's own far plane each frame (`update`) -- fixing a defect found
   * while wiring this task: the dome used to be built at a hardcoded radius 2000 while the game camera
   * (`pages/game/index.tsx`) has `far = 500`, so every dome vertex sat beyond the far clip plane and
   * the ENTIRE sky (this class or its sibling `SkyCone`, whichever was active) was clipped away and
   * never drew a single pixel, regardless of colours or uniforms. Scaling to `far * 0.9` (matching
   * benilla's own `follow_camera`) keeps the dome just inside the clip volume for whatever camera is
   * actually in use, rather than assuming a specific far value.
   */
  private createGeometry(): void {
    const widthSegments = 32;
    const heightSegments = 16;

    // No winding flip needed: an UNMODIFIED sphere's faces are wound CCW as seen from OUTSIDE (the
    // normal convention), which makes them the BACK faces as seen from INSIDE -- exactly where the
    // camera sits every frame (`update` pins the mesh to the camera position). `side: THREE.BackSide`
    // below is what actually selects that -- the legacy version of this file additionally flipped the
    // geometry with `geometry.scale(-1, 1, 1)`, which reverses the winding a SECOND time and makes the
    // sphere invisible from inside with `BackSide` (verified empirically while wiring this task: with
    // the flip in place, swapping to `THREE.DoubleSide` was the only way to see the dome at all;
    // removing the flip made plain `BackSide` render it correctly). That extra flip is why the sky was
    // never visible even before the far-clip radius bug this same pass fixed.
    const geometry = new THREE.SphereGeometry(1, widthSegments, heightSegments);

    this.geometry = geometry;
  }

  private createMaterial(): void {
    this.uniforms = {
      skyTop: { value: new THREE.Color(0.25, 0.5, 0.8) },
      skyMiddle: { value: new THREE.Color(0.25, 0.5, 0.8) },
      skyBand1: { value: new THREE.Color(0.25, 0.5, 0.8) },
      skyBand2: { value: new THREE.Color(0.25, 0.5, 0.8) },
      skySmog: { value: new THREE.Color(0.25, 0.5, 0.8) },
      skyFog: { value: new THREE.Color(0.25, 0.5, 0.8) },
      warpStrength: { value: 0 },
      sunAzimuth: { value: 0 },
      // Obviously-wrong debug gradient (see the fragment shader) until a real `MapLight` is attached
      // -- see `setMapLight`'s doc comment for why this must NOT look like a plausible sky.
      useFallback: { value: 1 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `
        varying vec3 vWorldPosition;

        void main() {
          vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 skyTop;
        uniform vec3 skyMiddle;
        uniform vec3 skyBand1;
        uniform vec3 skyBand2;
        uniform vec3 skySmog;
        uniform vec3 skyFog;
        // Dawn/dusk azimuthal warp (Task 4 Step 4) -- \`S\` (0 = identity, see \`skyWarp\`'s
        // doc) and the sun's own compass bearing in this client's Z-up XY horizontal plane.
        uniform float warpStrength;
        uniform float sunAzimuth;
        uniform float useFallback;

        varying vec3 vWorldPosition;

        const float TAU = 6.283185307179586;

        // Sun-relative azimuth phase -> glow factor g. Byte-for-byte port of
        // \`laws.skyWarpAzimuthGlow\` (JS) / benilla \`sky.wgsl::azimuth_glow\` -- keep the two in sync
        // by hand if either changes; \`laws.test.ts\` is what would catch a drift in the JS mirror,
        // this shader has no equivalent harness (no WebGL in jest), which is exactly why the JS
        // mirror exists and was unit-tested first.
        float skyWarpAzimuthGlow(float phase) {
          float p = fract(phase);
          if (p < 0.125) {
            return mix(0.0, 1.0, (p + 0.125) / 0.25);
          } else if (p < 0.375) {
            return mix(1.0, 0.0, (p - 0.125) / 0.25);
          } else if (p < 0.5) {
            return mix(0.0, -0.5, (p - 0.375) / 0.125);
          } else if (p < 0.625) {
            return mix(-0.5, -0.7, (p - 0.5) / 0.125);
          } else if (p < 0.75) {
            return mix(-0.7, -0.5, (p - 0.625) / 0.125);
          } else if (p < 0.875) {
            return mix(-0.5, 0.0, (p - 0.75) / 0.125);
          }
          return mix(0.0, 1.0, (p - 0.875) / 0.25);
        }

        // One mid-ring's warped colour for a single glow factor \`g\` and warp strength \`s\` --
        // matches \`laws.warpSkyRingColor\`/benilla \`sky.wgsl::warp_one\` exactly. At s = 0 this is
        // identity for EVERY g, which is the S = 0 case the brief calls out; \`applyAzimuthWarp\` below
        // also short-circuits on s <= 0 so that identity never even reaches this maths.
        vec3 warpSkyRingColor(vec3 base, vec3 warm, vec3 dark, float g, float s) {
          float s2 = s * s;
          if (g >= 0.0) {
            return mix(base, warm, (1.0 - g) * s2);
          }
          vec3 prepass = mix(base, warm, s);
          return mix(prepass, dark, 0.7 * (-g) * s2);
        }

        // Quantizes the fragment's sun-relative bearing to the reference's 24 azimuth segments
        // (matching the binary dome's per-vertex bake) and lerps between the two bracketing segments'
        // warped colours -- matches \`laws.applySkyAzimuthWarp\` exactly.
        vec3 applyAzimuthWarp(vec3 base, vec3 warm, vec3 dark, float fragAzimuth, float sunAz, float s) {
          if (s <= 0.0) {
            return base;
          }

          float az = fract((fragAzimuth - sunAz) / TAU + 0.125);
          float seg = az * 24.0;
          float seg0 = floor(seg);
          float f = seg - seg0;

          float g0 = skyWarpAzimuthGlow(seg0 / 24.0);
          float g1 = skyWarpAzimuthGlow((seg0 + 1.0) / 24.0);

          vec3 c0 = warpSkyRingColor(base, warm, dark, g0, s);
          vec3 c1 = warpSkyRingColor(base, warm, dark, g1, s);

          return mix(c0, c1, f);
        }

        void main() {
          // \`cameraPosition\` is one of three.js's ShaderMaterial builtins -- declaring it again here
          // would be a duplicate-uniform compile error. Subtracting it out matters: the dome tracks
          // the camera every frame (\`ProceduralSky#update\`) but the mesh's own vertex positions are
          // NOT re-centred on it, so \`vWorldPosition\` alone (without the subtraction the legacy
          // version of this shader was missing) is the camera's absolute world position offset by a
          // roughly-unit-length local point -- normalizing THAT gives a direction dominated by however
          // far the camera has wandered from the world origin, not the intended view direction.
          vec3 dir = normalize(vWorldPosition - cameraPosition);

          // This client is Z-up (see this file's module doc) -- elevation above the horizon reads off
          // \`dir.z\`, not \`dir.y\` as benilla's Y-up dome does.
          float elevDeg = degrees(asin(clamp(dir.z, -1.0, 1.0)));

          vec3 s1 = skyMiddle; // benilla SkyColor1 @ 16.8 deg
          vec3 s2 = skyBand1;  // SkyColor2 @ 9.8 deg
          vec3 s3 = skyBand2;  // SkyColor3 @ 3.7 deg
          vec3 s4 = skySmog;   // SkyColor4 @ 1.8 deg

          // Warp ONLY the 4 mid rings -- the zenith (skyTop) and the fog/horizon rim are left
          // UNWARPED, matching benilla's own (reconciled) sky.wgsl. At warpStrength <= 0 (all of
          // midday/deep night, and every hour in a highlightSky = 0 zone) \`applyAzimuthWarp\` returns
          // its input untouched, so this whole block is exactly identity -- verified directly in
          // \`laws.test.ts\`, not only by eyeballing the dome.
          if (warpStrength > 0.0) {
            float fragAzimuth = atan(dir.y, dir.x); // Z-up horizontal plane is XY, not XZ.
            s1 = applyAzimuthWarp(skyMiddle, skyMiddle, skyTop, fragAzimuth, sunAzimuth, warpStrength);
            s2 = applyAzimuthWarp(skyBand1, skyMiddle, skyTop, fragAzimuth, sunAzimuth, warpStrength);
            s3 = applyAzimuthWarp(skyBand2, skyMiddle, skyTop, fragAzimuth, sunAzimuth, warpStrength);
            s4 = applyAzimuthWarp(skySmog, skyMiddle, skyTop, fragAzimuth, sunAzimuth, warpStrength);
          }

          vec3 color;
          if (elevDeg <= 0.0) {
            color = skyFog; // horizon and below -- row 7, unwarped
          } else if (elevDeg < 1.8) {
            color = mix(skyFog, s4, elevDeg / 1.8);
          } else if (elevDeg < 3.7) {
            color = mix(s4, s3, (elevDeg - 1.8) / (3.7 - 1.8));
          } else if (elevDeg < 9.8) {
            color = mix(s3, s2, (elevDeg - 3.7) / (9.8 - 3.7));
          } else if (elevDeg < 16.8) {
            color = mix(s2, s1, (elevDeg - 9.8) / (16.8 - 9.8));
          } else {
            color = mix(s1, skyTop, (elevDeg - 16.8) / (90.0 - 16.8)); // warped ring1 -> UNWARPED zenith
          }

          // Deliberately obvious, not a plausible-looking blue default (see \`setMapLight\`'s doc): a
          // garish magenta/black elevation-banded stripe pattern that no authored DBC sky could ever
          // produce, so a regression that silently drops the \`MapLight\` reference reads as "the sky
          // is broken", never as "the sky just looks a bit flat today".
          if (useFallback > 0.5) {
            float stripe = mod(floor(elevDeg * 0.5), 2.0);
            color = mix(vec3(1.0, 0.0, 1.0), vec3(0.0, 0.0, 0.0), stripe);
          }

          // Raw output, no colour-space conversion -- the client's whole lighting pipeline is on the
          // gamma-passthrough lane (\`renderer.outputColorSpace = LinearSRGBColorSpace\`), matching
          // benilla's own "GL_FRAMEBUFFER_SRGB OFF" note for the real client's sky pass.
          gl_FragColor = vec4(color, 1.0);
        }
      `,
      side: THREE.BackSide, // Render from inside
      transparent: false,
      depthWrite: false, // Don't write to depth buffer
      depthTest: false, // Don't test against depth buffer
    });

    this.material = material;
  }

  /**
   * Pull the current frame's authored sky bands + warp inputs off `mapLight` and re-scale/reposition
   * the dome to the camera. `mapID` is accepted to match `SkyManager`'s common sky interface (`SkyCone`
   * takes it too); this dome has no per-map geometry of its own, so it is otherwise unused.
   */
  public update(camera: THREE.Camera, _mapID: number): void {
    this.position.copy(camera.position);
    this.visible = true;

    const far = (camera as THREE.PerspectiveCamera).far ?? 500;
    this.scale.setScalar(far * 0.9);

    if (!this.mapLight) {
      // `setMapLight` has never been called (yet) -- the obviously-wrong fallback stays on. Nothing
      // else to update: there is no light data to read.
      return;
    }

    this.uniforms.useFallback.value = 0;

    this.uniforms.skyTop.value.copy(this.mapLight.skyTopColor);
    this.uniforms.skyMiddle.value.copy(this.mapLight.skyMiddleColor);
    this.uniforms.skyBand1.value.copy(this.mapLight.skyBand1Color);
    this.uniforms.skyBand2.value.copy(this.mapLight.skyBand2Color);
    this.uniforms.skySmog.value.copy(this.mapLight.skySmogColor);
    this.uniforms.skyFog.value.copy(this.mapLight.fogColor); // row 7 -- the horizon colour.

    this.uniforms.warpStrength.value = this.mapLight.skyWarp;
    this.uniforms.sunAzimuth.value = this.mapLight.sunAzimuth;
  }

  /**
   * Set (or clear) the `MapLight` this dome reads its bands off. Called every frame by `SkyManager`
   * (`World#animate`), not once -- `changeMap` swaps in a brand-new `MapLight` per zone, so holding a
   * stale reference here would freeze the dome's colours at whatever the OLD zone last resolved (the
   * same staleness trap `WorldMap#adoptMaterial` documents for materials).
   *
   * `null` re-arms the obviously-wrong fallback gradient (see the fragment shader) -- this is the "no
   * `MapLight` reference at all" case, distinct from `MapLight`'s own documented (and intentionally
   * plausible) "no light records for this map" fallback, which this dome cannot tell apart from real
   * data by design: both arrive through the same getters.
   */
  public setMapLight(mapLight: MapLight | null): void {
    this.mapLight = mapLight;
    this.uniforms.useFallback.value = mapLight ? 0 : 1;
  }

  public dispose(): void {
    if (this.geometry) {
      this.geometry.dispose();
    }
    if (this.material) {
      if (Array.isArray(this.material)) {
        this.material.forEach((material) => material.dispose());
      } else {
        this.material.dispose();
      }
    }
  }
}

export default ProceduralSky;
