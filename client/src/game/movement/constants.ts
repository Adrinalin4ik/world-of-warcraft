/**
 * Movement constants, ported from the reference implementation (`samples/benilla`,
 * `crates/benilla/src/player/state.rs`).
 *
 * Values marked VERIFIED are binary-derived from WoW.exe 5875 and carry the address they came from.
 * Values marked TUNABLE are feel knobs the reference chose deliberately; those are the ones to
 * nudge if a real spot plays wrong.
 *
 * Do not strip these comments. Without provenance these are magic numbers, and nobody can tell
 * which of them are safe to change.
 *
 * Z-up note: this client is WoW-native (Z up, horizontal plane XY) where the reference is Bevy
 * (Y up). The constants themselves are scalars and transfer unchanged -- both are WoW yards, and
 * this client is already on that scale (`Chunk.SIZE = 33.33333` = 100/3 yd). Only the axis a rule
 * READS changes: `normal.z`, not `normal.y`.
 */

/** Backpedal speed as a fraction of run: vanilla MOVE_RUN_BACK 4.5 / MOVE_RUN 7.0. VERIFIED. */
export const RUN_BACK_RATIO = 4.5 / 7.0;

/**
 * Vanilla MOVE_RUN (yd/s) -- the fallback until server speeds stream in. Kept as a ratio base so a
 * speed override scales backpedal with it.
 */
export const RUN_SPEED = 7.0;

/**
 * Character turn rate (rad/s) -- how fast A/D rotate the avatar's facing when not mouse-looking.
 * VERIFIED (`0x7c4f30` heading integrate): the unit's 6th movement speed, vanilla default ~pi rad/s.
 */
export const TURN_RATE = Math.PI;

/** Turn-rate scale while also translating -- the verified x0.75 (the `flags & 0x200f` case). */
export const TURN_RATE_MOVING = 0.75;

/**
 * The mouselook pitch clamp (radians) -- VERIFIED +/-89.0 degrees = 1.5533431 (`0x8089d8`), the
 * camera SetPitch path's clamp.
 *
 * NOT +/-pi/2: that clamp belongs to the separate, rate-limited pitch-KEY integrator (`0x7c4f80`),
 * whose keys are default-unbound in 1.12 and which we do not bind.
 */
export const MOUSELOOK_PITCH_CLAMP = 1.553343;

/**
 * The stationary body catch-up: once steering input stops, the rendered body closes on the aim at
 * `turnRate x 8` rad/s (the client's chase, `0x607ed0` tail). While steering it is FROZEN, which is
 * what produces the head-leads-then-body-follows turn in place.
 */
export const STATIONARY_CHASE_RATE = 8.0;

/**
 * The ceiling on how fast the STANDING body may be dragged round by a mouse-look turn (rad/s).
 *
 * THE REFERENCE HAS NO SUCH LIMIT, and that is said here rather than implied. Its right-drag weld is an
 * absolute assignment of the camera yaw onto the aim (`benilla/src/player/camera.rs:352`,
 * `*face_yaw = cam.yaw`) and its standing body chase applies ONLY the 90-degree ceiling
 * (`player/gait.rs:58-63`), whose own doc says "the lag mechanism is the freeze, not a slow rate". So a
 * fast flick of the mouse rotates the body at whatever rate the camera turned, capped only by never
 * being left more than 90 degrees behind -- which is the owner's "он это должен делать медленнее".
 *
 * This cap is therefore a DIRECTOR'S CALL at his request, applied to the ceiling term only. The value
 * is the character's own turn rate: `TURN_RATE` (pi rad/s, the unit's 6th movement speed), so a mouse
 * turn cannot rotate the body faster than holding A or D does. Nothing in the binary is claimed for the
 * choice of where to cap -- only for the number, which is the same one the keyboard turn uses.
 *
 * The release sweep is deliberately NOT capped: it is the reference's `turnRate x 8` catch-up and
 * capping it would leave the body permanently askew after every turn.
 */
export const MOUSELOOK_BODY_TURN_RATE = Math.PI;

// -- Character-controller feel knobs -------------------------------------------------------------
// Binary-derived values kept because they give the WoW feel cheaply. TUNABLE, not fidelity targets:
// the mechanism is a thin kinematic controller over the swept cast, and refinements (accel/decel
// curves, partial air control beyond the one-shot nudge) dial up from here.

/** Player capsule radius (yd) -- the vanilla box's +/-1/3 half-width. TUNABLE. */
export const CAPSULE_RADIUS = 1 / 3;

/**
 * Player capsule total height (yd) -- the MOVEMENT capsule, deliberately a constant.
 *
 * Numerically equal to the vanilla ctor-default collision height it was derived from, but it is NOT
 * the same quantity and does not stand in for one: a unit's real collision height is per-model and
 * lives on the unit. This one feeds the swept box, the step-vs-fall election's reach and the
 * head/feet offsets, where going per-race would change where every short race can walk, step and
 * fit -- a movement-fidelity question of its own, kept apart on purpose. TUNABLE.
 */
export const CAPSULE_HEIGHT = 2.0277777;

/**
 * The client's own empty-world collision height (yd) -- the CMovement ctor's `0x4001c71c` at
 * `0x616fd8`, VERIFIED, which the per-unit setter overwrites from the unit's model.
 *
 * This is the fallback every depth line takes for a unit whose display id does not resolve. It is
 * NOT a stand-in for a real unit's height -- see the swim depth lines, which are fractions of the
 * unit's own value.
 */
export const DEFAULT_COLLISION_HEIGHT = 2.0277777;

/**
 * Downward gravity (yd/s^2) -- binary-VERIFIED vanilla value (matches vmangos `Movement::gravity`
 * exactly). Shared with any future remote dead-reckoner, so an observer's view of a jump matches
 * the mover's.
 */
export const GRAVITY = 19.291105;

/** Jump take-off speed (yd/s) -- binary-VERIFIED vanilla value. */
export const JUMP_SPEED = 7.955547;

/** Terminal fall speed (yd/s) -- binary-VERIFIED (matches vmangos `terminalVelocity`). */
export const TERMINAL_VELOCITY = 60.148003;

/**
 * Standability gate: a surface is walkable iff its normal is within ~50 degrees of straight up
 * (cos 50, the vanilla threshold). Steeper than this you cannot climb it and you slide back down.
 *
 * Z-up port: compare against `normal.z`, never `normal.y`.
 */
export const GROUND_COS = 0.642788;

/** Downward probe distance (yd) to decide whether we are standing on ground. TUNABLE. */
export const GROUND_PROBE = 0.2;

/**
 * The post-move downward snap's SLOPE RATIO -- the client's step-vs-fall election (`0x6367b0`,
 * constant `[0x80c740]` = 1.8493990). The snap probe reaches
 * `horizontalTravel * ratio + slack + collisionHeight` below the post-move position.
 *
 * Scaling by the travel makes the absorbed SLOPE the constant (atan 1.8494 ~= 61.6 degrees,
 * comfortably above the 50 degree walkable limit) and therefore frame-rate independent. The
 * collision-height term is what absorbs a discrete ledge: a fence-height drop is a silent
 * straight-down step, and only a deeper floor becomes a fall. VERIFIED.
 */
export const STEP_SLOPE_RATIO = 1.849399;

/** The election's fixed slack (yd) added to the travel-scaled snap reach -- `[0x7ff9d0]` = 1/36 yd. */
export const STEP_SNAP_SLACK = 1 / 36;

/**
 * The step-up rise ceiling (yd): how tall an obstacle the atomic step-up can walk you onto.
 *
 * TUNABLE and deliberately modest -- stairs, doorsteps, low rocks -- and deliberately NOT the
 * reference client's ~2 yd body-height budget, so fences (collision tops 1.8-2.3 yd) always slide.
 * One number to nudge if a real spot feels too restrictive.
 */
export const STEP_UP_HEIGHT = 0.7;

/**
 * The landing probe (yd): while airborne, walk mode resumes only this close to the floor, so the
 * arc ends where the slide actually contacts.
 *
 * The wider GROUND_PROBE would end the arc up to 0.2 yd early and close the gap with a same-frame
 * snap -- a visible pop at every silent landing.
 */
export const LAND_PROBE = 0.05;

/**
 * Consecutive stalled airborne frames that mean a capsule is wedged between steep faces.
 *
 * A capsule can come to rest held between two steep faces -- the flaring trunk bases of the
 * Northshire trees form exactly this funnel -- where gravity feeds the slide, the opposing contacts
 * cancel it, and with mid-air control locked the falling pose is permanent. This many stalled
 * frames in a row is unambiguously a rest, so land there. Nothing becomes walkable by this.
 */
export const WEDGE_STILL_FRAMES = 3;

/**
 * A frame counts as stalled when the achieved descent is under this fraction of the descent gravity
 * INTENDED. Free fall achieves ~100% and a steep-slope slide >=75% (the steeper the face, the freer
 * the vertical), so only opposing contacts hold an arc under this.
 *
 * Measuring against the intent -- which keeps growing while the funnel eats the motion -- catches
 * the pinch as it happens, rather than after a visible decelerating-millimetre tail in the falling
 * pose.
 */
export const WEDGE_STALL_RATIO = 0.15;

/**
 * Fall speed (yd/s) the arc must exceed before stalled frames count. A jump apex hovers near zero
 * and never qualifies; a wedge accumulates gravity while frozen and passes within a few frames.
 */
export const WEDGE_MIN_FALL = 1.0;

/**
 * One-shot air-control nudge (yd/s): a jump from a standstill can be steered this much in the
 * pressed direction; a jump taken with momentum keeps it locked (vanilla feel). Less than a walking
 * jump, deliberately.
 */
export const AIR_NUDGE_SPEED = 2.5;

/**
 * The FALLINGFAR distance leg (yd): a JUMP arc (launch vz != 0) latches once it descends this far
 * below its launch height -- `0x633240`, constant `[0x80dff8]` = 1/9 yd.
 *
 * A flat jump never descends below its takeoff, so it never latches -- its hang stays the jump pose.
 * The legs are exclusive on the launch vz: step-off falls take FALL_FAR_TIME instead.
 */
export const FALL_FAR_DROP = 1 / 9;

/**
 * The FALLINGFAR timer leg (s): a STEP-OFF fall (launch vz = 0, the walk election's
 * `StartFalling(0)`) latches once airborne this long -- `0x633240`'s accumulator test,
 * `0x1f4` = 500 ms. Free-falling from rest that is ~2.41 yd of descent.
 */
export const FALL_FAR_TIME = 0.5;

/** Skin width (yd) kept between the capsule and geometry on casts. */
export const SKIN_WIDTH = 0.02;

/**
 * Max seconds to hold the avatar after a teleport while the world streams in -- provided the
 * destination's terrain has actually arrived by then. See `SETTLE_STREAM_TIMEOUT`.
 */
export const SETTLE_TIMEOUT = 6.0;

/**
 * The settle hold's ABSOLUTE cap (s), used only while the destination's terrain is still missing.
 *
 * WHY THERE ARE TWO TIMEOUTS. `SETTLE_TIMEOUT` alone released the hold after six seconds whatever the
 * world had managed to load, and if the ADT under the spawn had not registered yet, gravity took the
 * avatar straight through it. MEASURED on a live entry as `Gesf` with the ADT fetches delayed 20 s
 * (`scratchpad/f2-fall-slow.js`): released at 6 s, `velZ` pinned at -TERMINAL_VELOCITY (-60.15), and
 * 441 terrain chunks plus 1289 doodads finished loading while the body kept falling past -4400 --
 * because nothing re-grounds a body that is already below the terrain. That is the owner's report to
 * the digit (`z: -5087`, `vz: -60.15`, `fallFar: true`).
 *
 * So the six-second release now requires `TerrainProvider#heightAt` to answer: with terrain under us
 * and still no floor, we really are over a hole or a cliff and the fall is correct. This cap is what
 * keeps that from ever becoming a hang -- an instance with no ADT at all, or a load that never
 * completes, releases here instead. `VoidRescue` then catches the body if ground does turn up later.
 */
export const SETTLE_STREAM_TIMEOUT = 30.0;

/** Max contact iterations one collide-and-slide resolves before giving up on the remainder. */
export const MAX_SLIDE_ITERATIONS = 4;

/**
 * Half the capsule's AXIS SEGMENT -- the distance from the centre to either cap centre. This, not
 * half the total height, is what the swept cast wants.
 */
export function capsuleHalfSegment(): number {
  return CAPSULE_HEIGHT / 2 - CAPSULE_RADIUS;
}
