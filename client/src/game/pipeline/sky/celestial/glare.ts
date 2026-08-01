import * as THREE from 'three';
import TextureLoader from '../../texture-loader';
import { moonDiscScale, sunFlareDn, moonFlareDn } from '../../../world/light/laws';
import {
  CELESTIAL_DISTANCE,
  viewLerp,
  flareHorizonGate,
  flareSlew,
  SUN_FLARE_RISE,
  MOON_FLARE_RISE,
  FLARE_FALL,
} from '../../../world/sky/celestial/laws';
import CelestialBillboard from './billboard';
import { CelestialLightSource } from './sun';
import { MoonLightSource } from './moons';

/**
 * The sun and moon glare -- the celestial-sky plan's Task 5, and the payoff for the cloud coverage
 * field (`world/sky/clouds/kernel.ts`'s `occ1Sun`/`occ1Moon`): its first real consumer.
 *
 * Both glares are additive quads co-located with their discs on the shared near sphere
 * (`cam + 12*dir`, `laws.CELESTIAL_DISTANCE`) -- NOT the far plane the discs sit just inside of. The
 * plan records exactly why: a far-placed quad at the byte-law flare size pierced the sky dome and the
 * depth test cut a giant faceted halo edge (decision 0500). `CelestialBillboard`'s `applyHorizonFade:
 * false` already keeps glares off the disc's horizon clip -- their own envelope (below) hides an
 * occluded flare instead.
 *
 * Ported from `samples/benilla/crates/benilla/src/sun/follow.rs`'s `follow_sun`/`follow_moons` GLARE
 * arms and the module's `view_lerp`/`horizon_gate`/`flare_slew` (all now in
 * `world/sky/celestial/laws.ts`, VERIFIED, decision 0508):
 *
 * - **Sun glare** (`sunGlare.blp`): quad scale `lerp(3, 20, f)` world units, intensity
 *   `lerp(0.5, 1, f) * envelope`, `f` the view lerp toward `celestialSunDir`. A DAY flare -- its
 *   dnCurve (`laws.sunFlareDn`) is 0 until 06:30, full 07:30-19:30, gone by 21:00.
 * - **Moon glare** (`moonglare.blp`): quad scale `2.0 * laws.moonDiscScale` (the moon's own size
 *   curve, ~1.14x the white moon disc -- both view-lerp endpoints get the SAME curve, so the size is
 *   f-independent, unlike the sun's), intensity `lerp(0.1, 1, f) * envelope`. A DEEP-NIGHT halo -- its
 *   dnCurve (`laws.moonFlareDn`) is flat zero until 22:45, full only near midnight.
 *
 * Tint is `MapLight.celestialTint` for both, never hardcoded -- see `billboard.ts`'s own tint-law doc.
 *
 * ## The envelope -- the reference's `[glare+0x30]` slewed scalar
 *
 * Each glare owns ONE persistent `env` scalar (seeded at 0, like the reference's `.bss` -- a flare
 * always rises into view rather than snapping on). Every frame a slew TARGET is assembled from:
 * - the body's own **dnCurve** (`sunFlareDn`/`moonFlareDn`) -- the day/night gate above,
 * - `laws.flareHorizonGate(dirZ)` -- the glare's OWN below-horizon smoothstep (distinct from the
 *   disc's `horizonClipFade`; see that function's doc comment for why the two are not the same gate),
 * - `occ1` -- the cloud coverage over the body's 12-unit sky point, the caller-supplied factor that
 *   wires this file to `SkyManager`'s single shared `CloudKernel` instance (plan Risk 5: sampling a
 *   SECOND field would dim the flare for clouds nobody can see).
 *
 * The reference also gates on a terrain/interior occlusion probe (Addendum #8: a fractional ray-grid
 * march against streamed terrain, the GPU occlusion query's CPU stand-in). This client has no
 * per-pixel terrain-height oracle to march against (no `TerrainStreamer` equivalent exists), so this
 * port carries the INTERIOR half of that gate -- `MapLight.location === 'interior'` zeroes the target
 * exactly like the reference's `camera_interior.0.is_some()` check -- and does not attempt the terrain
 * ray-march half, which would need new streaming infrastructure well beyond this task's scope. Noted
 * as a known gap rather than silently dropped.
 *
 * The target then slews toward the current value via `laws.flareSlew` (asymmetric linear rise/fall,
 * NOT an exponential ease -- the reference's own byte-pinned rates), producing the frame's envelope.
 */

const SUN_GLARE_TEXTURE_PATH = 'Textures\\sunGlare.blp';
const MOON_GLARE_TEXTURE_PATH = 'Textures\\moonglare.blp';

/** The plan's draw-order ladder: glare is +1000 -- after the world, unlike every other sky element
 * (the reference draws it as the frame's last render; its envelope, not the depth buffer, hides an
 * occluded flare). Both glares share this slot -- additive blending makes their relative order among
 * themselves immaterial. */
export const GLARE_RENDER_ORDER = 1000;

/** Scratch vector for `camera.getWorldDirection`, reused every `updateFromLight` call rather than
 * reallocated. */
const SCRATCH_FORWARD = new THREE.Vector3();

/**
 * The sun's additive lens flare. Constructed with a placeholder texture and swaps in the real
 * `sunGlare.blp` once it resolves, exactly like `SunDisc`.
 */
class SunGlare extends CelestialBillboard {
  private resolvedTexture: THREE.Texture | null = null;

  private disposedFlag = false;

  /** The reference's `[glare+0x30]` slewed envelope scalar -- seeded at 0 so the flare always rises
   * into view. */
  private env = 0;

  constructor() {
    super(TextureLoader.PLACEHOLDER, {
      renderOrder: GLARE_RENDER_ORDER,
      blending: 'additive',
      applyHorizonFade: false,
      distance: CELESTIAL_DISTANCE,
    });
    this.name = 'SunGlare';

    TextureLoader.load(SUN_GLARE_TEXTURE_PATH)
      .then((texture: THREE.Texture) => {
        if (this.disposedFlag) {
          TextureLoader.unload(texture);
          return;
        }
        this.resolvedTexture = texture;
        this.setTexture(texture);
      })
      .catch((error: unknown) => {
        console.error(`SunGlare: failed to load ${SUN_GLARE_TEXTURE_PATH}:`, error);
      });
  }

  /**
   * Per-frame: resolve the view lerp, the slewed envelope (dnCurve x horizon gate x `occ1` x the
   * interior gate), and delegate placement/tint to the shared billboard. `occ1` is
   * `world/sky/clouds/kernel.ts`'s `occ1Sun(coverage)`, sampled by the caller (`SkyManager`) at this
   * body's 12-unit sky point off the SAME kernel instance the cloud dome renders from. `interior` is
   * `MapLight.location === 'interior'` -- see this file's module doc for why the terrain-ray-march
   * half of the reference's occlusion gate is not ported. `dt` is the same per-frame delta driving
   * every other per-frame system in this client (never a second clock).
   */
  public updateFromLight(
    camera: THREE.Camera,
    light: CelestialLightSource,
    occ1: number,
    interior: boolean,
    dt: number,
  ): void {
    const minute = light.timeProgression * 1440;
    const dir = light.celestialSunDir;

    const forward = camera.getWorldDirection(SCRATCH_FORWARD);
    const f = viewLerp(forward, dir);

    const dn = sunFlareDn(minute);
    const gate = flareHorizonGate(dir.z);
    const target = interior ? 0 : dn * gate * occ1;
    this.env = flareSlew(this.env, target, SUN_FLARE_RISE, FLARE_FALL, dt);

    // `lerp(3, 20, f)` world units -- on the near sphere the builder's units are the quad scale
    // directly (see `laws.CELESTIAL_DISTANCE`'s own doc).
    this.setScale(3 + 17 * f);
    // Intensity: the view lerp's `lerp(0.5, 1, f)` x the slewed envelope. Rides the tint's alpha
    // multiplier (NOT the tint colour's own alpha byte, forced to 1 -- see `billboard.ts`'s tint doc).
    this.setTint(light.celestialTint, (0.5 + 0.5 * f) * this.env);
    this.update(camera, dir);
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

/**
 * The white moon's additive glare ring. Constructed with a placeholder texture and swaps in the real
 * `moonglare.blp` once it resolves.
 */
class MoonGlare extends CelestialBillboard {
  private resolvedTexture: THREE.Texture | null = null;

  private disposedFlag = false;

  private env = 0;

  constructor() {
    super(TextureLoader.PLACEHOLDER, {
      renderOrder: GLARE_RENDER_ORDER,
      blending: 'additive',
      applyHorizonFade: false,
      distance: CELESTIAL_DISTANCE,
    });
    this.name = 'MoonGlare';

    TextureLoader.load(MOON_GLARE_TEXTURE_PATH)
      .then((texture: THREE.Texture) => {
        if (this.disposedFlag) {
          TextureLoader.unload(texture);
          return;
        }
        this.resolvedTexture = texture;
        this.setTexture(texture);
      })
      .catch((error: unknown) => {
        console.error(`MoonGlare: failed to load ${MOON_GLARE_TEXTURE_PATH}:`, error);
      });
  }

  /**
   * Per-frame: the same shape `SunGlare.updateFromLight` follows, but off the white moon's own
   * direction/size curve and dnCurve -- see this file's module doc for the moon's DEEP-NIGHT envelope
   * and its `2.0 * moonDiscScale` size law (both view-lerp endpoints share the curve, so scale is
   * f-independent here, unlike the sun's).
   */
  public updateFromLight(
    camera: THREE.Camera,
    light: MoonLightSource,
    occ1: number,
    interior: boolean,
    dt: number,
  ): void {
    const minute = light.timeProgression * 1440;
    const dir = light.moonDir;

    const forward = camera.getWorldDirection(SCRATCH_FORWARD);
    const f = viewLerp(forward, dir);

    const dn = moonFlareDn(minute);
    const gate = flareHorizonGate(dir.z);
    const target = interior ? 0 : dn * gate * occ1;
    this.env = flareSlew(this.env, target, MOON_FLARE_RISE, FLARE_FALL, dt);

    // `2.0 * the moon size curve` world units -- both the reference's view-lerp scale endpoints get
    // this SAME curve, so unlike the sun the quad's SIZE never depends on `f`.
    this.setScale(2.0 * moonDiscScale(minute));
    // Intensity: the view lerp's `lerp(0.1, 1, f)` x the slewed envelope.
    this.setTint(light.celestialTint, (0.1 + 0.9 * f) * this.env);
    this.update(camera, dir);
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

export { SunGlare, MoonGlare };
