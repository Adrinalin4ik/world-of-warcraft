import * as THREE from 'three';
import TextureLoader from '../../texture-loader';
import { moonDiscScale } from '../../../world/light/laws';
import { CELESTIAL_DISTANCE } from '../../../world/sky/celestial/laws';
import CelestialBillboard from './billboard';

/**
 * The white moon and moon02 (celestial-sky plan, Task 4) -- the third and fourth bodies on the shared
 * `CelestialBillboard` (Task 1), following the exact pattern `sun.ts` (Task 2) established: a
 * per-body class that owns only "which texture, which render slot, how to resolve this body's inputs
 * off `MapLight`", and delegates placement/tint/fade entirely to the shared billboard.
 *
 * **White moon** -- `moon.blp`, alpha blend, base size x1.75 (`laws.moonDiscScale` on top, the
 * reference's own horizon-enlargement curve), azimuth 45 degrees (the sun's own bearing). Direction
 * is `MapLight.moonDir` (`laws.moonDirection`, already ported and tested for the cloud glow --
 * reused here, not re-derived, exactly as the plan asks). `renderOrder = -1001`: where the discs
 * cross, the moon paints over the sun (plan ladder: stars -1003, sun -1002, white moon -1001, moon02
 * -1000.5, gradient dome -1000, cloud dome -999).
 *
 * Tint is `MapLight.celestialTint` (`BAND_SUN_COLOR`), never a hardcoded colour (plan Risk 1) -- the
 * moon and its glare are warm, not cool. The director's Westfall "teal rim" observation is NOT
 * reproduced by tinting the moon (see this file's own module doc below, and the plan): it is the
 * dome's teal night bands alpha-blending through the moon disc's feathered edge and horizon fade. If
 * that rim is not visible when scrubbing to night, the bug lives in the dome or the fade, not here.
 *
 * **moon02** -- `moon02.blp`, drawn every frame per the reference's draw order, but the reference's
 * colour field `[0xce98a4]` has NO writer in the binary: it renders vertex-BLACK on a
 * phase-precessed schedule (`fmod(dayCounter + todPhase, 1.7)`, clamped to `[0, 1]`, parking frozen
 * high for the whole `[1.0, 1.7)` leg -- see `laws.moon02State`) and can never read as a second moon.
 * This class is ported ONLY because omitting it silently changes what is on screen -- it is NOT
 * "fixed" into visibility: its tint is hardcoded black at alpha 0, matching the reference's own
 * unwritten `.bss` colour dword exactly (the one disc in this file that deliberately does NOT read
 * `celestialTint`). `renderOrder = -1000.5`, between the white moon and the gradient dome.
 */

const MOON_TEXTURE_PATH = 'Textures\\moon.blp';
const MOON02_TEXTURE_PATH = 'Textures\\moon02.blp';

/** The plan's draw-order ladder: white moon -1001 (over the sun where they cross), moon02 -1000.5
 * (over the white moon, under the gradient dome). */
export const WHITE_MOON_RENDER_ORDER = -1001;
export const MOON02_RENDER_ORDER = -1000.5;

/** The reference's unit-quad-at-`CELESTIAL_DISTANCE` convention -- `laws.moonDiscScale` (and, for
 * moon02, its own phase-sampled size scale) multiplies this every frame. */
const MOON_BASE_SIZE = 1.0;

/** The white moon's own base multiplier on top of the shared moon-size curve (`SUN_SIZE * 1.75` in
 * the reference's own units -- see `sun/follow.rs::SUN_SIZE` and `follow_moons`). moon02's own base
 * is x1.0, i.e. no multiplier at all. */
const WHITE_MOON_BASE_MULTIPLIER = 1.75;

/** The minimal shape `WhiteMoon.updateFromLight` needs off `MapLight` -- kept as a structural
 * interface (rather than importing the class itself), matching `sun.ts`'s own `CelestialLightSource`
 * so this file and its tests do not need to construct a real `MapLight`. */
export interface MoonLightSource {
  readonly celestialTint: THREE.Color;
  readonly moonDir: THREE.Vector3;
  readonly timeProgression: number;
}

/** The minimal shape `Moon02.updateFromLight` needs off `MapLight` -- deliberately narrower than
 * `MoonLightSource`: moon02 never reads `celestialTint` (its colour is hardcoded black, matching the
 * reference's own unwritten colour dword), so this interface does not even offer it. */
export interface Moon02LightSource {
  readonly moon02Dir: THREE.Vector3;
  readonly moon02Scale: number;
}

/**
 * The white moon disc sprite. Constructed with a placeholder texture (the same pattern `SunDisc`
 * uses) and swaps in the real `moon.blp` once it resolves.
 */
class WhiteMoon extends CelestialBillboard {
  private resolvedTexture: THREE.Texture | null = null;

  private disposedFlag = false;

  constructor() {
    super(TextureLoader.PLACEHOLDER, {
      renderOrder: WHITE_MOON_RENDER_ORDER,
      blending: 'alpha',
      applyHorizonFade: true,
      distance: CELESTIAL_DISTANCE,
    });
    this.name = 'WhiteMoon';

    TextureLoader.load(MOON_TEXTURE_PATH)
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
        console.error(`WhiteMoon: failed to load ${MOON_TEXTURE_PATH}:`, error);
      });
  }

  /**
   * Per-frame: resolve this body's tint/size/direction off `MapLight` and delegate placement to the
   * shared billboard -- the same shape `SunDisc.updateFromLight` follows.
   */
  public updateFromLight(camera: THREE.Camera, light: MoonLightSource): void {
    const minute = light.timeProgression * 1440;

    this.setTint(light.celestialTint, 1);
    this.setScale(MOON_BASE_SIZE * WHITE_MOON_BASE_MULTIPLIER * moonDiscScale(minute));
    this.update(camera, light.moonDir);
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

/** Hardcoded black, alpha 0 -- the reference's own unwritten `[0xce98a4]` colour dword. This is the
 * ONE disc in the celestial-sky plan deliberately exempt from Risk 1 (never a hardcoded colour):
 * moon02 IS a hardcoded colour in the reference itself, because nothing in the binary ever writes it. */
const MOON02_TINT = new THREE.Color(0, 0, 0);

/**
 * moon02 -- drawn every frame, vertex-black, never visible. See this file's module doc for why this
 * exists at all rather than being cut from the draw order.
 */
class Moon02 extends CelestialBillboard {
  private resolvedTexture: THREE.Texture | null = null;

  private disposedFlag = false;

  constructor() {
    super(TextureLoader.PLACEHOLDER, {
      renderOrder: MOON02_RENDER_ORDER,
      blending: 'alpha',
      applyHorizonFade: true,
      distance: CELESTIAL_DISTANCE,
    });
    this.name = 'Moon02';

    TextureLoader.load(MOON02_TEXTURE_PATH)
      .then((texture: THREE.Texture) => {
        if (this.disposedFlag) {
          TextureLoader.unload(texture);
          return;
        }
        this.resolvedTexture = texture;
        this.setTexture(texture);
      })
      .catch((error: unknown) => {
        console.error(`Moon02: failed to load ${MOON02_TEXTURE_PATH}:`, error);
      });
  }

  /**
   * Per-frame: place moon02 on its own phase-precessed bearing (`MapLight.moon02Dir`), sized off its
   * own phase-sampled scale (`MapLight.moon02Scale`) -- but tinted black at alpha 0 always, per this
   * file's module doc. Do not "fix" this into visibility.
   */
  public updateFromLight(camera: THREE.Camera, light: Moon02LightSource): void {
    this.setTint(MOON02_TINT, 0);
    this.setScale(MOON_BASE_SIZE * light.moon02Scale);
    this.update(camera, light.moon02Dir);
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

export { WhiteMoon, Moon02 };
