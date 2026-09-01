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
 * **THE STEP-UP'S FORWARD REACH (yd), and it is a property of the BODY, not of the frame rate.**
 *
 * How far the maneuver must reach to SEE the tread it would stand on is a question about the
 * body's width, so it cannot be this frame's travel -- and passing travel for it is the defect the
 * owner walked into. Measured on his own trace at a step he could not climb: `fwd` equal to `travel`
 * at 0.17-0.22 yd, the elevated sweep completely free, and the settle nevertheless descending 0.6991
 * of a 0.7 rise -- back onto its own floor, `climb` 0.0009, refused by the net-zero bar.
 *
 * The arithmetic says why, and it is about the capsule's WIDTH. Pressed against a riser the centre
 * stands `CAPSULE_RADIUS + skin` from its plane; advancing one frame leaves the centre still BEHIND
 * that plane, so the descending capsule's lower sphere still overhangs the floor it came from --
 * 0.70 away, where the tread edge is 1.16 away. The nearer surface wins and the maneuver lands where
 * it started. To clear the lip the advance must exceed a radius, and a radius is not a time.
 *
 * **THE VALUE IS THE GAME'S, not a body-scaled guess of ours.** The reference reads it out of the
 * client at `0x636193`, where `ebx` is `max(H * tan50deg, radius + 1/720)` and has exactly two uses,
 * both the LENGTH argument to the sweep at `0x632ba0` -- never added to a position. With the
 * verified `H` of 1.0 (decision 1125: `0x617430` is `[unit+0xb8]`, the dimensionless scale ratio,
 * so a player's `H` is 1.0) that is **1.1917536**
 * (`samples/benilla/crates/benilla-app/src/player/state.rs:184`).
 *
 * That 1.0 is the CLIENT's step budget and our own `STEP_UP_HEIGHT` above is not -- 0.7 is ours and
 * deliberately modest. The two are independent and both stay: this constant is a SWEEP LENGTH, and
 * lengthening a sweep does not widen what may be climbed. The reference makes that argument
 * explicitly and it is what makes the longer reach safe: the rise ceiling still bounds the lift, the
 * settle must still find a WALKABLE floor higher than the feet, and -- the load-bearing part -- the
 * elevated forward sweep is CLIPPED by anything in the way, so the advance only ever reaches as far
 * as there is clear air at the raised height. A fence, a trunk and a two-trunk pinch still block at
 * the same body height, with a clipped advance and a net-zero settle.
 *
 * The frame's own travel still wins when it is longer, so this is a FLOOR and not a fixed reach: a
 * very low frame rate never steps you less far than you asked to walk.
 */
export const STEP_UP_ADVANCE = 1.1917536;

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

/**
 * **HOW FAR BELOW THE FEET A FLOOR MUST BE FOUND to end the post-load settle hold (yd).**
 *
 * The hold released on a downward probe of **200 yd**, which does not mean "there is a floor under
 * me" -- it means "there is something, anywhere, in the world below me". Spawn INSIDE a building
 * and the terrain beneath it streams in before the building's own floor does: the probe finds
 * ground eighty yards down, the hold lifts, gravity starts, and the body is under the WMO floor by
 * the time that floor arrives. Which is the owner's "проваливаюсь под текстуры после загрузки",
 * exactly.
 *
 * Five yards is local enough to mean the floor the body will actually stand on, and loose enough
 * for the gap between the server's Z and our own collision surface, which is a fraction of a yard
 * in practice.
 *
 * Nothing hangs on being conservative here, and that asymmetry is why the number can be tight: a
 * probe that finds nothing does not freeze the body for ever -- it falls through to the two
 * timeouts below it, which release on the terrain being registered, and then unconditionally.
 */
export const SETTLE_FLOOR_REACH = 5.0;

/** Max contact iterations one collide-and-slide resolves before giving up on the remainder. */
export const MAX_SLIDE_ITERATIONS = 4;

/**
 * **THE LONGEST HORIZONTAL STEP ONE SUBSTEP MAY RESOLVE (yd).**
 *
 * The owner's requirement, in his words: "нам нужно чтобы мы не проваливались под текстуры даже с
 * низким фпс". A swept capsule cannot tunnel at any `dt`, so the failure at low frame rates is not
 * leakage -- it is that everything else in a step is scaled by the travel. The slide gets four
 * iterations however far it is going, the step-up looks ahead by one frame's travel, and the
 * descent cap is `travel * 1.849`. At 27 fps his travel measured 0.35 yd, three times what a 60 fps
 * frame resolves, so the same geometry is met with a third of the resolution.
 *
 * A substep bounded in DISTANCE makes all of that frame-rate independent: the body meets the world
 * in steps of the same size whatever the clock does. 0.12 yd is one 60 fps walking frame at 7 yd/s,
 * which is the resolution this mover has actually been tuned and measured at.
 */
export const MAX_SUBSTEP_TRAVEL = 0.12;

/**
 * **ONE. SUBSTEPPING IS OFF, AND THE MEASUREMENT THAT TURNED IT OFF IS WHY THE CONSTANT STAYS.**
 *
 * I shipped this at 3 with the cost stated as "up to three times the movement step on slow frames
 * only" and asked for the number. The number came back **`ctl.move` 17.3 ms against 3.8** -- not
 * three times but four and a half, and 13.5 ms added to a frame whose whole budget is 16.7. It is the
 * largest single item in his profile, larger than `world.animate`.
 *
 * Worse than the multiplier: it is SELF-AMPLIFYING in exactly the way I wrote the ceiling to prevent
 * and the ceiling did not prevent. A step that costs 13 ms more makes the frame longer, a longer frame
 * travels further, and further travel buys the full three substeps every frame instead of on the rare
 * slow one. The cap bounds the count; it cannot bound the feedback, because the feedback runs through
 * the frame time and not through the count.
 *
 * The GOAL is still right and the owner asked for it: the body should meet the world at the same
 * resolution whatever the clock does. But it cannot be bought at 4.5x, and the prerequisite is now
 * clear -- ONE step has to be cheap first. At 3.8 ms it is already a fifth of the budget, and the
 * reason for that is the next thing to measure, not to guess.
 *
 * Left as a constant rather than deleted so the mechanism, the measurement and the prerequisite stay
 * where the next person will look. Set it above 1 only with `ctl.move` in front of you.
 *
 * ---
 *
 * The original reasoning, kept because it is still the argument FOR doing this once a step is cheap:
 * they cost proportionally and the frame was already over budget.
 *
 * Measured on the owner's panel: `ctl.move` 3.8 ms on the abbey stairs, in a frame whose p50 is 19.3
 * against a 16.7 budget. Substepping an over-budget frame without a ceiling is a feedback loop --
 * a slow frame travels further, which buys more substeps, which makes the frame slower. Three is
 * enough to cover 0.36 yd of travel, i.e. down to about 19 fps at walking speed, and bounds the
 * added cost at twice one step rather than at whatever the frame rate collapses to.
 *
 * Past the ceiling the substeps simply get longer, and the sweep still cannot tunnel -- the
 * degradation is in resolution, not in soundness.
 */
export const MAX_SUBSTEPS = 1;

/**
 * Half the capsule's AXIS SEGMENT -- the distance from the centre to either cap centre. This, not
 * half the total height, is what the swept cast wants.
 */
export function capsuleHalfSegment(): number {
  return CAPSULE_HEIGHT / 2 - CAPSULE_RADIUS;
}
