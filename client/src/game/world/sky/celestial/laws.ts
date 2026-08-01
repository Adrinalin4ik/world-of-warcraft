/**
 * Pure maths for the celestial billboard shared by every sun/moon disc and glare
 * (`docs/superpowers/plans/2026-08-01-celestial-sky.md`, Task 1). No three.js import -- see
 * `world/light/laws.ts`, `world/light/fog.ts`, `world/light/weather.ts` and
 * `world/sky/clouds/kernel.ts` for the same convention in this project: pure functions are
 * node-testable and reusable off the render thread, and callers convert to/from THREE types at the
 * boundary.
 *
 * Ported from `samples/benilla/crates/benilla/src/sun/{mesh,materials,follow}.rs` and the
 * `sun/mod.rs` module header: the builder `0x6d3b80` places every celestial body -- disc AND glare
 * alike -- on a camera-centred sphere (`pos = cam + distance*dir`, world space, no local->world
 * rotation folded in), and every disc routes through the shared horizon clip+fade `0x6d1960` so it
 * sets/rises edge-first instead of popping in and out at the horizon line.
 *
 * This client does not depth-test its sky (`sky_order.rs`'s whole reason for existing in the
 * reference -- squashed depth slices and a `SKY_FAR_DEPTH` shader trick -- does not port here; see
 * the plan's "The reference's fixed sky pass" section). With no occlusion trick to fight, there is no
 * reason to split discs onto a far shell and glares onto a near one the way `follow.rs` does for
 * Bevy's benefit: every body in this client sits on the SAME `cam + 12*dir` sphere, and draw order is
 * plain `renderOrder` integers (the plan's ladder table).
 */

/** A structural direction/offset -- no three.js import in this pure module. Z-up (this client's
 * unpermuted WoW frame; see `MapLight#updateSunDirection`'s own convention and `kernel.ts`'s frame
 * note): `z` is the vertical axis, positive above the horizon. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** The reference's shared near-sphere radius (`[0x80c4e8]`, decision 0485/0500) -- every celestial
 * body in this client sits here, disc and glare alike, since nothing in the sky depth-tests (see this
 * module's own doc comment). */
export const CELESTIAL_DISTANCE = 12;

/**
 * The horizon clip+fade scale for a body on the shared [`CELESTIAL_DISTANCE`]-unit sphere (benilla
 * `materials.rs::DISC_HORIZON_FADE`, the real client's `0x6d1960`): `alpha = clamp(2.5*height, 0, 1)`
 * with `height = CELESTIAL_DISTANCE * dirZ` reduces to `clamp(30*dirZ, 0, 1)`.
 */
export const HORIZON_FADE_SCALE = 2.5 * CELESTIAL_DISTANCE;

/**
 * The shared horizon clip+fade every celestial disc AND glare routes through (benilla `0x6d1960`):
 * `0` at or below the horizon (`dirZ <= 0`, the body clipped entirely), ramping linearly to `1` over
 * the ~1.9-degree band above it (`dirZ >= 1/HORIZON_FADE_SCALE`), `1` at every higher elevation.
 * Without this a body pops sharply in/out crossing the horizon instead of setting/rising edge-first.
 *
 * `dirZ` is the `z` (up) component of the unit camera->body direction -- `sin(elevation)` in this
 * client's Z-up frame, matching `MapLight#cloudGlowDir`/`laws.moonDirection`'s own convention.
 */
export function horizonClipFade(dirZ: number, scale: number = HORIZON_FADE_SCALE): number {
  return Math.min(1, Math.max(0, scale * dirZ));
}

/**
 * The shared near-sphere placement (benilla `0x6d3b80`): a camera-anchored point at
 * `cam + distance*dir`, world space, no local->world rotation folded in -- pure vector arithmetic so
 * it is testable without a `THREE.Camera`. `dir` is assumed a unit toward-body vector; callers
 * (`MapLight#cloudGlowDir`, `laws.moonDirection`, ...) already normalize it.
 */
export function billboardPosition(
  cam: Vec3Like,
  dir: Vec3Like,
  distance: number = CELESTIAL_DISTANCE,
): Vec3Like {
  return {
    x: cam.x + dir.x * distance,
    y: cam.y + dir.y * distance,
    z: cam.z + dir.z * distance,
  };
}
