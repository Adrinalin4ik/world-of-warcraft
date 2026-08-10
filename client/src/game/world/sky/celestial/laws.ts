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

/**
 * The glare's `0x6cf490` **view lerp** (celestial-sky plan, Task 5; benilla `sun/follow.rs::view_lerp`,
 * VERIFIED): `f = saturate((cosTheta - 0.7) / 0.3)`, `cosTheta` the dot of the camera's forward axis
 * and the camera->body direction -- 0 until the view swings within ~45 degrees of the body, ramping to
 * 1 as it lines up dead-on. Drives both the sun and moon glare's quad scale and intensity lerps.
 */
export function viewLerp(camForward: Vec3Like, toBody: Vec3Like): number {
  const cosTheta = camForward.x * toBody.x + camForward.y * toBody.y + camForward.z * toBody.z;
  return Math.min(1, Math.max(0, (cosTheta - 0.7) / 0.3));
}

/**
 * The glare's own below-horizon gate (benilla `sun/follow.rs::horizon_gate`, VERIFIED): a smoothstep
 * on the body's `sin(elevation)` (`dirZ` in this client's Z-up frame) -- 0 at/below the horizon,
 * ramping to 1 over the next ~2 degrees. Distinct from [`horizonClipFade`] (the DISC's clip+fade,
 * `HORIZON_FADE_SCALE = 30`): the reference uses a separate, steeper gate here (`1/0.035 ~= 28.6`) as
 * one factor of the glare's slewed envelope target, not as the glare material's own alpha -- glares
 * never route the disc's horizon clip (see `billboard.ts`'s `applyHorizonFade` doc).
 */
export function flareHorizonGate(dirZ: number): number {
  const t = Math.min(1, Math.max(0, dirZ / 0.035));
  return t * t * (3 - 2 * t);
}

/** The sun glare's envelope rise rate, `[glare+0x28]` (`0xce97d0`, VERIFIED, decision 0508): units/sec. */
export const SUN_FLARE_RISE = 4.0;
/** The moon glare's envelope rise rate, `[glare+0x28]` (`0xce9720`, VERIFIED, decision 0508):
 * 100/33 ~= 3.0303 units/sec -- slower than the sun's. */
export const MOON_FLARE_RISE = 100 / 33;
/** The shared envelope fall rate, `[glare+0x2c]` (`0xce97d4`/`0xce9724`, VERIFIED, decision 0508):
 * 50/33 ~= 1.5152 units/sec -- a killed flare takes ~0.66s to go dark, slower than either rise. */
export const FLARE_FALL = 50 / 33;

/**
 * One step of the reference's `[glare+0x30]` **asymmetric linear slew** toward `target`
 * (benilla `sun/follow.rs::flare_slew`, VERIFIED, decision 0508): rising is capped at `rise*dt`,
 * falling at `fall*dt`, and the value never overshoots the target. Not an exponential ease -- the
 * reference's own byte-pinned constants are linear rates.
 */
export function flareSlew(current: number, target: number, rise: number, fall: number, dt: number): number {
  const delta = Math.min(rise * dt, Math.max(-fall * dt, target - current));
  return current + delta;
}
