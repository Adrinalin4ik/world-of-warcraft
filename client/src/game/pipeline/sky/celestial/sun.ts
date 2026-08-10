import * as THREE from 'three';
import TextureLoader from '../../texture-loader';
import { sunDiscScale } from '../../../world/light/laws';
import { CELESTIAL_DISTANCE } from '../../../world/sky/celestial/laws';
import CelestialBillboard from './billboard';

/**
 * The sun disc (celestial-sky plan, Task 2) -- the first body on the shared `CelestialBillboard`
 * (Task 1), and the pattern Tasks 3-5 (stars, the two moons, the glare) follow: a per-body class
 * that owns nothing but "which texture, which render slot, and how to resolve this body's inputs
 * off `MapLight` every frame", and delegates placement/tint/fade entirely to the shared billboard.
 *
 * `sunCenter.blp`, plain alpha blend, a 1.0-unit quad at the shared near-sphere radius (`laws.
 * CELESTIAL_DISTANCE` = 12 -- angular diameter `2*atan(0.5/12) = 4.77deg`). Size is multiplied every
 * frame by `laws.sunDiscScale` (the vanilla size table `0xce8cac`): 2x at the dawn/dusk horizon, 1x
 * across midday -- the reference's own curve, not an invented lerp. `renderOrder = -1002` per the
 * plan's draw-order ladder (stars -1003, sun disc -1002, white moon -1001, ...).
 *
 * ## Direction: a DEDICATED sun-only vector, not `MapLight.cloudGlowDir`
 *
 * The plan's own text says to reuse `cloudGlowDir` (the negated `sunDir`) -- but that vector is
 * built from `MapLight#sunDir`, the near-fixed LIGHTING sun (`SUN_PHI_TABLE`/`SUN_THETA_TABLE`,
 * elevation only ~20-37 degrees all day), not benilla's separate "visible celestial sun" that
 * actually rises and sets (`daynight.rs::celestial_sun_direction`, elevation 100deg at night down to
 * 5deg at noon). Reusing `cloudGlowDir` would park the disc high in the sky at all hours, never
 * touching the horizon -- defeating both the 2x horizon-size curve above and the shared horizon
 * clip+fade (`laws.horizonClipFade`), and it ALSO silently becomes the white moon's direction outside
 * `cloudGlowIsSun`'s ~04:50-22:10 window (see `MapLight#updateCloudGlow`'s own doc comment) -- wrong
 * for a sun disc at any hour, let alone at night.
 *
 * So this file reads the newly-published `MapLight.celestialSunDir` instead (`laws.
 * celestialSunDirection`, ported here as part of this task): a to-sun vector dedicated to the sun
 * alone, in this client's unpermuted WoW frame (Z up), that genuinely crosses the horizon at
 * dawn/dusk and never swaps bodies.
 *
 * ## Tint (Risk 1 of the plan)
 *
 * `MapLight.celestialTint` every frame, alpha forced to 1 -- never a hardcoded disc colour. See
 * `CelestialBillboard`'s own module doc for the alpha/tint split.
 */

const SUN_TEXTURE_PATH = 'Textures\\sunCenter.blp';

/** The plan's draw-order ladder: stars -1003, sun disc -1002, white moon -1001, ... */
export const SUN_DISC_RENDER_ORDER = -1002;

/** The reference's unit-quad-at-`CELESTIAL_DISTANCE` convention -- `laws.sunDiscScale` multiplies
 * this every frame. */
const SUN_BASE_SIZE = 1.0;

/** The minimal shape `SunDisc.update` needs off `MapLight` -- kept as a structural interface
 * (rather than importing the class itself) so this file, and its tests, do not need to construct a
 * real `MapLight` (DBC loads, area-light selection, ...) just to drive the sun disc. The real
 * `MapLight` satisfies this shape today and will keep doing so as Tasks 3-5 read more of it. */
export interface CelestialLightSource {
  readonly celestialTint: THREE.Color;
  readonly celestialSunDir: THREE.Vector3;
  readonly timeProgression: number;
}

/**
 * The sun disc sprite. Constructed with a placeholder texture (`TextureLoader.PLACEHOLDER`, the same
 * pattern `ParticleMaterial` uses) and swaps in the real `sunCenter.blp` once it resolves, so the
 * disc exists and can be placed/tinted from frame one even before the async BLP decode completes.
 */
class SunDisc extends CelestialBillboard {
  private resolvedTexture: THREE.Texture | null = null;

  private disposedFlag = false;

  constructor() {
    super(TextureLoader.PLACEHOLDER, {
      renderOrder: SUN_DISC_RENDER_ORDER,
      blending: 'alpha',
      applyHorizonFade: true,
      distance: CELESTIAL_DISTANCE,
    });
    this.name = 'SunDisc';

    TextureLoader.load(SUN_TEXTURE_PATH)
      .then((texture: THREE.Texture) => {
        if (this.disposedFlag) {
          // Disposed before the async decode landed -- release it rather than pinning a reference
          // nothing will ever render.
          TextureLoader.unload(texture);
          return;
        }
        this.resolvedTexture = texture;
        this.setTexture(texture);
      })
      .catch((error: unknown) => {
        console.error(`SunDisc: failed to load ${SUN_TEXTURE_PATH}:`, error);
      });
  }

  /**
   * Per-frame: resolve this body's tint/size/direction off `MapLight` and delegate placement to the
   * shared billboard. Tasks 3-5 follow this exact shape -- a body-specific method that reads
   * `MapLight`, then calls the inherited `update(camera, dir)` -- so `SkyManager`'s per-frame wiring
   * stays a flat list of these calls rather than growing per-body special cases.
   */
  public updateFromLight(camera: THREE.Camera, light: CelestialLightSource): void {
    const minute = light.timeProgression * 1440;

    this.setTint(light.celestialTint, 1);
    this.setScale(SUN_BASE_SIZE * sunDiscScale(minute));
    this.update(camera, light.celestialSunDir);
  }

  public dispose(): void {
    super.dispose();
    this.disposedFlag = true;
    if (this.resolvedTexture) {
      TextureLoader.unload(this.resolvedTexture);
      this.resolvedTexture = null;
    }
  }
}

export default SunDisc;
