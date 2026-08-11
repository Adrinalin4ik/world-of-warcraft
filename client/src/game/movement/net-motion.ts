import * as THREE from 'three';

/**
 * The two kinds of NETWORK motion this client has to draw, and the interpolation each one gets.
 *
 * They are genuinely different problems and they get genuinely different answers, which is the
 * whole reason this module exists rather than one shared "smooth towards the target" helper:
 *
 *  - **A creature's spline** (`SMSG_MONSTER_MOVE`) is a path plus a DURATION. The server has told
 *    us the entire future of this walk, so there is nothing to predict and nothing to smooth: the
 *    unit is at a known point of a known polyline at a known time. `sampleSpline` evaluates it,
 *    arc-length parameterised, and its accuracy is bounded by the frame rate and nothing else. A
 *    walk that ends is a walk that ends AT THE SERVER'S DESTINATION, exactly, because the sampler
 *    clamps to the last point.
 *
 *  - **A peer player's `MSG_MOVE_*`** carries a position, a facing AND a movement-flag word. The
 *    flags are the statement about the future that a bare position lacks: `FORWARD` means he is
 *    still walking forward, at the speed his flags pick, until a packet says otherwise. So a peer is
 *    DEAD-RECKONED from his last reported state (`advanceRemote`), and a packet SNAPS the pose and
 *    re-seeds the integrator (`applyRemoteMove`). That is the reference's model, ported from
 *    `samples/benilla/crates/benilla/src/net/motion/remote.rs` (`RemoteMotion::advance`,
 *    `apply_move`), and it is what the real client does.
 *
 *    THIS REPLACED A SNAPSHOT INTERPOLATOR, and the reason is a defect the owner reported and this
 *    module caused. The old scheme opened, on every message, an interpolation from the drawn pose to
 *    the wire pose over the OBSERVED interval since that peer's PREVIOUS message. That makes the
 *    window a one-step-behind predictor of the next gap, and the sender's cadence is not steady:
 *    `network/game/object/player/movement.ts:450` emits `MSG_MOVE_SET_FACING` on EVERY frame the
 *    facing changes (~33 ms while the mouse moves) and falls back to a 500 ms `MSG_MOVE_HEARTBEAT`
 *    only when nothing else went out (`:461`). So the intervals alternate short and long, and both
 *    directions are visibly wrong:
 *
 *      - window 80 ms (floored from a 33 ms facing burst) followed by a 500 ms heartbeat gap: the
 *        peer covers the whole step in 80 ms and then STANDS STILL for 420 ms;
 *      - window 500 ms followed by a 33 ms burst: 93% of the step is still untravelled when the new
 *        target is set, and the leftover plus the new step is crammed into the next 80 ms -- a RUSH.
 *
 *    Stall, then rush, on the heartbeat period. That is the owner's report verbatim ("каждые 500мс
 *    происходит остановка анимации и ускорении того кто следует"), and the animation stalled with it
 *    because `Unit#updateLocomotion` chose the gait from the measured per-frame displacement, which
 *    a stalled interpolation reports as zero -- i.e. as Stand. Dead reckoning has no window to run
 *    dry and the gait now comes off the flags, so neither half can recur.
 *
 * WHAT IS NOT PORTED, said plainly. The reference does not apply a relayed move at arrival either:
 * it gives each one a client FIRE-TIME from a per-unit replay chain and drains the queue when the
 * clock reaches it, with a pre-fire reconcile lerp converging the dead-reckon onto the queued pose
 * (`net/motion/relay.rs`, `remote.rs#reconcile_lerp`, decisions 0601/0615). That chain is paced by
 * the packet's own `MovementInfo.time` wire stamp, and the caller here
 * (`network/game/object/player/movement.ts:276`) does not pass it -- that file is owned by another
 * agent this round and was left alone. So a packet applies AT ARRIVAL, as an outright snap: the
 * reference's own `WOW_REMOTE_SNAP=1` A/B mode (`remote.rs#arrival_snap`). The residual it snaps is
 * structurally small, because the dead-reckon has been covering the mover's own timeline in between;
 * the schedule buys de-jitter on top, not the smoothness itself.
 *
 * Also not ported: the reference resolves each dead-reckoned step against the world with the same
 * swept capsule the local avatar uses (decision 0626), which is what stops an invented step walking
 * a watched player into geometry and what gives a grounded mover its height every frame. Without it
 * a peer's Z only changes where a packet puts it -- the reference's own pre-0626 behaviour, still
 * available there as `WOW_REMOTE_FLAT=1`. Named here rather than left as a silent gap.
 *
 * Both are pure functions over plain state so they can be reasoned about (and tested) with no
 * scene, no packets and no clock.
 */

/** A server-dictated path being walked. `null` when the unit is not path-walking. */
export interface SplineRide {
  /** Full travel-order polyline, world coords. At least two points. */
  points: THREE.Vector3[];
  /** Cumulative arc length at each point; `lengths[0] === 0`. */
  lengths: number[];
  /** Total path length (yd). */
  total: number;
  /** `performance.now()` ms at which the ride began -- BACK-DATED for a walk already in progress. */
  startedMs: number;
  durationMs: number;
  /**
   * A 3-D curve rather than a ground walk. Ground paths are evaluated as straight segment lerps,
   * which is what the real client's creature follow does; only the flying family curves.
   */
  flying: boolean;
  /** The server's spline id, echoed in `CMSG_MOVE_SPLINE_DONE` when a spline drives US. */
  id: number;
  /** Final facing to hold once the walk ends, radians, or null to keep the travel facing. */
  finalFacing: number | null;
}

export interface SplineSample {
  position: THREE.Vector3;
  /** Travel facing (radians), or null for a degenerate direction -- keep the previous facing. */
  facing: number | null;
  /** True once the ride's duration has elapsed. */
  done: boolean;
}

/** Build a ride from a decoded path. Returns null for anything that is not a walk. */
export function makeSplineRide(
  points: { x: number; y: number; z: number }[],
  durationMs: number,
  flying: boolean,
  nowMs: number,
  options: { timePassedMs?: number; id?: number; finalFacing?: number | null } = {},
): SplineRide | null {
  if (durationMs <= 0 || points.length < 2) {
    return null;
  }
  const timePassedMs = options.timePassedMs ?? 0;
  if (timePassedMs >= durationMs) {
    // The server has already finished this walk. Replaying it would put the unit back at the start.
    return null;
  }

  const vecs = points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const lengths: number[] = [0];
  let total = 0;
  for (let i = 1; i < vecs.length; ++i) {
    total += vecs[i].distanceTo(vecs[i - 1]);
    lengths.push(total);
  }
  if (total <= 1e-6) {
    return null;
  }

  return {
    points: vecs,
    lengths,
    total,
    startedMs: nowMs - timePassedMs,
    durationMs,
    flying,
    id: options.id ?? 0,
    finalFacing: options.finalFacing ?? null,
  };
}

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Where the unit is at `nowMs`, at constant arc-length speed along the ride, clamped at both ends.
 *
 * `out` is written in place: this runs once per path-walking unit per frame and must not allocate.
 */
export function sampleSpline(
  ride: SplineRide,
  nowMs: number,
  out: THREE.Vector3,
): SplineSample {
  const frac = Math.min(1, Math.max(0, (nowMs - ride.startedMs) / ride.durationMs));
  const want = frac * ride.total;

  // Which segment holds `want`. A linear scan: paths here are 2..8 points (measured on the
  // 642-packet capture), so a binary search would cost more in branches than it saves.
  let seg = ride.points.length - 2;
  for (let i = 1; i < ride.lengths.length; ++i) {
    if (want <= ride.lengths[i]) {
      seg = i - 1;
      break;
    }
  }

  const segLength = ride.lengths[seg + 1] - ride.lengths[seg];
  const t = segLength > 1e-6 ? Math.min(1, Math.max(0, (want - ride.lengths[seg]) / segLength)) : 0;

  const a = ride.points[seg];
  const b = ride.points[seg + 1];

  if (ride.flying) {
    catmullRom(ride.points, seg, t, out, _dir);
  } else {
    out.copy(a).lerp(b, t);
    _dir.copy(b).sub(a);
  }

  const facing = (_dir.x * _dir.x + _dir.y * _dir.y) > 1e-6 ? Math.atan2(_dir.y, _dir.x) : null;
  return { position: out, facing, done: frac >= 1 };
}

/**
 * Uniform Catmull-Rom on segment `i`, neighbours phantom-duplicated at the ends so the curve passes
 * through every waypoint. Only the flying family takes this; a ground walk is a straight lerp.
 */
function catmullRom(
  pts: THREE.Vector3[],
  i: number,
  u: number,
  out: THREE.Vector3,
  dir: THREE.Vector3,
): void {
  _p0.copy(pts[Math.max(0, i - 1)]);
  _p1.copy(pts[i]);
  _p2.copy(pts[i + 1]);
  _p3.copy(pts[Math.min(pts.length - 1, i + 2)]);

  const u2 = u * u;
  const u3 = u2 * u;
  const axis: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
  for (const a of axis) {
    const c1 = _p2[a] - _p0[a];
    const c2 = 2 * _p0[a] - 5 * _p1[a] + 4 * _p2[a] - _p3[a];
    const c3 = -_p0[a] + 3 * _p1[a] - 3 * _p2[a] + _p3[a];
    out[a] = 0.5 * (2 * _p1[a] + c1 * u + c2 * u2 + c3 * u3);
    dir[a] = 0.5 * (c1 + 2 * c2 * u + 3 * c3 * u2);
  }
}

/**
 * 3.3.5a `MovementFlags`, the bits the dead-reckon and the gait selector read.
 *
 * Duplicated from `network/game/movement-info.ts` for the reason `movement/outbound.ts` already
 * gives for its own copy: `game/` does not import from `network/`, and inverting that for a handful
 * of constants would make the movement layer -- which every movement test constructs -- depend on
 * the packet layer. They cannot drift silently: the same words are written into outgoing packets
 * from `outbound.ts`, so a mismatch is a desync on the first step taken.
 *
 * Values cross-checked against the reference's own table (`select.rs:96-197`, `mod move_flags`).
 */
export const MoveFlag = {
  FORWARD: 0x00000001,
  BACKWARD: 0x00000002,
  STRAFE_LEFT: 0x00000004,
  STRAFE_RIGHT: 0x00000008,
  TURN_LEFT: 0x00000010,
  TURN_RIGHT: 0x00000020,
  WALK_MODE: 0x00000100,
  FALLING: 0x00001000,
  FALLING_FAR: 0x00002000,
  SWIMMING: 0x00200000,
} as const;

/** Any of the four translation bits -- the reference's `ANY_MOVE` (`select.rs:177`). */
export const ANY_MOVE = MoveFlag.FORWARD | MoveFlag.BACKWARD
  | MoveFlag.STRAFE_LEFT | MoveFlag.STRAFE_RIGHT;

/**
 * The per-unit speed set the dead-reckon integrates with, yd/s.
 *
 * The wire supplies these per unit through `MSG_MOVE_SET_*_SPEED`; until one arrives every unit
 * shares the 3.3.5a defaults. `turnRate` is radians/s.
 */
export interface MoveSpeeds {
  walk: number;
  run: number;
  runBack: number;
  swim: number;
  swimBack: number;
  turnRate: number;
}

/** Vanilla / 3.3.5a base speeds. `run` matches `movement/constants.ts#RUN_SPEED`. */
export const DEFAULT_MOVE_SPEEDS: MoveSpeeds = {
  walk: 2.5,
  run: 7.0,
  runBack: 4.5,
  swim: 4.722222,
  swimBack: 2.5,
  turnRate: Math.PI,
};

/**
 * Gravity and terminal velocity for a peer's ballistic arc -- the same constants the local mover
 * integrates with (`movement/constants.ts`), duplicated here only to keep this module's dependency
 * surface to `three`. The reference drives every mover with one `g` for exactly this reason.
 */
const GRAVITY = 19.291105;
const TERMINAL_VELOCITY = 60.148003;

/**
 * Beyond this gap (yd) a peer's new position is a RELOCATION, not travel: a worldport, a spawn, or
 * simply the first message after he walked out of and back into our grid. A packet always snaps the
 * pose, so this is REPORTED rather than acted on here -- it is how the caller tells a correction of
 * a few centimetres (the normal case, and the whole point of dead reckoning) from a teleport.
 */
export const REMOTE_SNAP_DISTANCE = 40;

/**
 * How long a peer may dead-reckon in silence before `remoteSilentMs` counts as a RUNAWAY, ms.
 *
 * The reference's `RUNAWAY_SILENCE_MS` (`remote.rs:147`), and for the same purpose: a mover is fed at
 * worst every 500 ms by its own heartbeat, so two seconds of silence with a direction flag still set
 * means we are inventing motion the server never described. Reporting only -- nothing here corrects
 * the pose, exactly as the reference's watch does not.
 */
export const RUNAWAY_SILENCE_MS = 2000;

/** A peer's `MSG_MOVE_*` stream, dead-reckoned. */
export interface RemoteMotion {
  /** Last authoritative position, advanced by extrapolation between packets. */
  pos: THREE.Vector3;
  /** Facing (radians), advanced while a `TURN_*` flag is set. */
  orientation: number;
  /** The peer's movement flags as of his last packet. */
  flags: number;
  /** Swim pitch (radians, +up) as of his last packet; 0 when not swimming. */
  pitch: number;
  /**
   * The horizontal speed the extrapolation is currently applying, yd/s. This is what the gait
   * selector reads for a peer -- the reference's `RemoteMotion::speed`, consumed by `select::unify`
   * (`select.rs:1069-1103`) exactly as a spline's speed is for a creature.
   */
  speed: number;
  /** Vertical speed while airborne, yd/s (+Z up). 0 on the ground. */
  verticalVelocity: number;
  /** Horizontal velocity frozen at a jump's launch (world XY yd/s). Zero on the ground. */
  jumpVelX: number;
  jumpVelY: number;
  /**
   * This airborne phase began with a `MSG_MOVE_JUMP` (a jump tail on the wire), not with a step off
   * a ledge.
   *
   * The animation layer needs the distinction and cannot infer it: the reference plays JumpStart 37
   * only for an arc that LAUNCHED, and a step-off fall keeps its current gait until `FALLING_FAR`
   * latches (`select.rs:288-292`). Both arrive here carrying `FALLING`.
   */
  jumped: boolean;
  /** `performance.now()` of the last applied packet, and where it put him: the dead-reckon's anchor. */
  lastApplyMs: number;
  lastApplyPos: THREE.Vector3;
  /** True until the first packet has been applied. */
  fresh: boolean;
}

export function createRemoteMotion(): RemoteMotion {
  return {
    pos: new THREE.Vector3(),
    orientation: 0,
    flags: 0,
    pitch: 0,
    speed: 0,
    verticalVelocity: 0,
    jumpVelX: 0,
    jumpVelY: 0,
    jumped: false,
    lastApplyMs: 0,
    lastApplyPos: new THREE.Vector3(),
    fresh: true,
  };
}

/** Shortest signed angle, so a facing never eases the long way round. */
export function wrapPi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * How fast a rendered body yaw eases toward its target heading, rad/s of exponential rate.
 *
 * The client blends the DISPLAY facing a quarter of the remaining gap per frame (`0x607ed0` tail,
 * `x0.25` `[0x8029b0]`); at 60 fps that is the continuous rate `-ln(0.75) x 60 = 17.26 /s`. The
 * time-based form is taken rather than the frame-rate-dependent quarter, exactly as the reference
 * does (`samples/benilla/crates/benilla/src/creature_anim/select.rs:199-204`, `STRAFE_BLEND_RATE`).
 */
export const DISPLAY_YAW_BLEND_RATE = 17.26;

/**
 * The rendered body-yaw OFFSET a strafing unit holds, radians, left-positive.
 *
 * There is no ground strafe GAIT in WoW -- the run cycle keeps playing and the whole strafe is
 * expressed by yawing the body off the aim, which is why `gaitCandidates` has no strafe rung. A pure
 * strafe is a right angle; a strafe held together with forward or back is 45 degrees, and a
 * backpedalling strafe mirrors (you still lead with the same shoulder).
 *
 * Verbatim from `samples/benilla/crates/benilla/src/creature_anim/select.rs:228-243`
 * (`strafe_body_offset`), whose sign table is pinned by `select/tests.rs:631-647`:
 * `LEFT -> +pi/2`, `RIGHT -> -pi/2`, `LEFT|FORWARD -> +pi/4`, `LEFT|BACKWARD -> -pi/4`, and
 * `LEFT|RIGHT` (both held) -> 0.
 */
export function strafeBodyOffset(flags: number): number {
  const left = (flags & MoveFlag.STRAFE_LEFT) !== 0;
  const right = (flags & MoveFlag.STRAFE_RIGHT) !== 0;
  if (left === right) {
    return 0;
  }
  const diagonal = (flags & (MoveFlag.FORWARD | MoveFlag.BACKWARD)) !== 0;
  const magnitude = diagonal ? Math.PI / 4 : Math.PI / 2;
  const back = (flags & MoveFlag.BACKWARD) !== 0;
  return left !== back ? magnitude : -magnitude;
}

/**
 * One frame of the display-facing blend: ease `current` toward `aim + offset`.
 *
 * Done in AIM-RELATIVE offset space rather than on absolute yaw, and that is the whole trick -- the
 * reference's `ease_strafe_yaw` (`select.rs:213-217`). Easing absolute yaws makes a left-to-right
 * strafe flip a `+90 -> -90` transition whose shortest arc is a 180-degree tie, so the body swings
 * through the BACK as often as through the front. In offset space the same flip is `+90 -> -90`
 * about the aim, which always passes through 0 -- through the front.
 */
export function easeDisplayYaw(
  current: number,
  aim: number,
  offset: number,
  dt: number,
  rate: number = DISPLAY_YAW_BLEND_RATE,
): number {
  const cur = wrapPi(current - aim);
  const eased = cur + (offset - cur) * (1 - Math.exp(-rate * (dt > 0 ? dt : 0)));
  return wrapPi(aim + eased);
}

/** The jump tail a `MSG_MOVE_JUMP` carries, when it carries one. */
export interface RemoteJumpInfo {
  /**
   * The wire's vertical speed for this airborne phase. **READ AS A MAGNITUDE, because its SIGN
   * CONVENTION IS NOT SETTLED FOR 3.3.5a AND WE DO NOT NEED IT.**
   *
   * The reference documents down-positive -- a NEGATIVE value for a rising jump -- and says so on the
   * strength of a vanilla sniff (`remote.rs:629-634`, `jump_seed`). That is 1.12 evidence, and
   * `CLAUDE.md`'s rule is to take mechanism from the reference and version-numbered values from the
   * game's own data. A sign is a value.
   *
   * TAKING IT ON TRUST COST A ROUND. `-zSpeed` was used verbatim, and the owner then watched a peer
   * jump in the official 3.3.5a client and be drawn buried to the chest for the whole arc. MEASURED,
   * by making our own sender emit the opposite convention on an otherwise unchanged path (the observed
   * peer's rendered Z minus the terrain height under his own XY, per frame): the airborne error ran to
   * -1.5 .. -3.9 yd, p05 -2.04, against +1.64 yd of clean rise when the signs agreed. Nothing else in
   * the capture moved -- grounded error stayed at p50 +0.014 yd either way.
   *
   * WHY THE MAGNITUDE IS CORRECT WITHOUT SETTLING THE CONVENTION: an airborne phase in WoW never
   * LAUNCHES downward. A jump and a knockback launch upward; a step off a ledge is the walk election's
   * `StartFalling(0)` and launches at exactly zero. There is no fourth case. So `|zspeed|` is the
   * take-off up-speed under either convention, and `|zspeed| - g * fallTime` is the current one --
   * which is also why `fallTime` has to be the arc's own age and why `zspeed` has to be the arc's
   * LAUNCH value rather than its live velocity (the second half of the outbound bug this round fixed).
   *
   * A sender that emitted its LIVE vertical velocity instead of the launch value would defeat this,
   * since mid-fall its magnitude is a descent. This client was that sender until this round; a real
   * client is not, because `fallTime` is meaningless unless `zspeed` is the constant.
   */
  zSpeed: number;
  sinAngle: number;
  cosAngle: number;
  xySpeed: number;
}

/** One relayed move, as it came off the wire. */
export interface RemoteMove {
  x: number;
  y: number;
  z: number;
  facing: number;
  flags: number;
  pitch?: number;
  /** Ms since this airborne phase began, from the wire. Only meaningful alongside `jump`. */
  fallTime?: number;
  jump?: RemoteJumpInfo | null;
}

/**
 * Apply one relayed move: snap the pose and RE-SEED the integrator.
 *
 * The reference's `apply_move` (`remote.rs:301-345`) minus the transport rider and the landing
 * predictor, neither of which exists in this client. Returns how far the snap moved him, so the
 * caller can tell a routine correction from a relocation (`REMOTE_SNAP_DISTANCE`).
 */
export function applyRemoteMove(
  motion: RemoteMotion,
  move: RemoteMove,
  nowMs: number,
): number {
  const gap = motion.fresh
    ? 0
    : Math.hypot(move.x - motion.pos.x, move.y - motion.pos.y, move.z - motion.pos.z);

  // The ballistic seed. A non-jumping packet (a ground move, or `FALL_LAND`) clears both and the
  // mover resumes flag-driven walking.
  if (move.jump) {
    const t = (move.fallTime ?? 0) / 1000;
    // THE MAGNITUDE, NOT THE SIGN, AND THAT IS THE FIX. See `RemoteJumpInfo#zSpeed` for the whole
    // argument and the measurement; in one line: an airborne phase never LAUNCHES downward in WoW's
    // movement model, so `|zspeed|` is the take-off up-speed under either wire convention, and the
    // current up-speed is that minus gravity over the arc's own `fallTime`.
    const launchUp = Math.abs(move.jump.zSpeed);
    motion.verticalVelocity = Math.max(-TERMINAL_VELOCITY, launchUp - GRAVITY * t);
    motion.jumpVelX = move.jump.cosAngle * move.jump.xySpeed;
    motion.jumpVelY = move.jump.sinAngle * move.jump.xySpeed;
    // A LAUNCH has a non-zero take-off speed; a step off a ledge is the walk election's
    // `StartFalling(0)` and carries EXACTLY zero, whichever sign the sender uses for the rest. That is
    // what separates "he jumped" from "he walked off a kerb", and only the first plays JumpStart.
    motion.jumped = launchUp > 1e-3;
  } else {
    motion.verticalVelocity = 0;
    motion.jumpVelX = 0;
    motion.jumpVelY = 0;
    motion.jumped = false;
  }

  motion.pos.set(move.x, move.y, move.z);
  motion.orientation = move.facing;
  motion.flags = move.flags;
  motion.pitch = move.pitch ?? 0;
  motion.lastApplyMs = nowMs;
  motion.lastApplyPos.copy(motion.pos);
  motion.fresh = false;

  return gap;
}

/**
 * Advance a peer one frame of dead reckoning. Writes `out` and returns the facing.
 *
 * A port of the reference's `RemoteMotion::advance` (`remote.rs:705-798`): on the ground, integrate
 * the velocity the LIVE FLAGS imply in the facing frame, at the run / run-back / walk / swim speed
 * those flags pick, and rotate the facing while a `TURN_*` flag is set. Airborne it is one ballistic
 * event instead -- horizontal frozen at the launch, height a parabola under gravity -- because
 * direction cannot change mid-air, so the ground direction flags are deliberately ignored there.
 *
 * `motion.speed` is written as a side effect and IS the peer's gait speed; see the field's docs.
 */
export function advanceRemote(
  motion: RemoteMotion,
  speeds: MoveSpeeds,
  dtSeconds: number,
  out: THREE.Vector3,
): number {
  const dt = dtSeconds > 0 ? dtSeconds : 0;

  if ((motion.flags & MoveFlag.FALLING) !== 0) {
    motion.pos.x += motion.jumpVelX * dt;
    motion.pos.y += motion.jumpVelY * dt;
    motion.pos.z += motion.verticalVelocity * dt;
    motion.verticalVelocity = Math.max(
      -TERMINAL_VELOCITY,
      motion.verticalVelocity - GRAVITY * dt,
    );
    motion.speed = Math.hypot(motion.jumpVelX, motion.jumpVelY);
    out.copy(motion.pos);
    return motion.orientation;
  }

  let turn = 0;
  if ((motion.flags & MoveFlag.TURN_LEFT) !== 0) turn += 1;
  if ((motion.flags & MoveFlag.TURN_RIGHT) !== 0) turn -= 1;
  motion.orientation += turn * speeds.turnRate * dt;

  // Travel direction in the facing frame (WoW: forward = (cos o, sin o), left = +90 degrees).
  // Swimming, the FORWARD axis is pitched by the reported swim pitch, so a diving swimmer descends
  // between packets instead of sliding flat; the STRAFE axis stays level.
  const swimming = (motion.flags & MoveFlag.SWIMMING) !== 0;
  const hp = swimming ? Math.cos(motion.pitch) : 1;
  const vp = swimming ? Math.sin(motion.pitch) : 0;
  const fwdX = Math.cos(motion.orientation);
  const fwdY = Math.sin(motion.orientation);

  let fwdAmt = 0;
  if ((motion.flags & MoveFlag.FORWARD) !== 0) fwdAmt += 1;
  if ((motion.flags & MoveFlag.BACKWARD) !== 0) fwdAmt -= 1;
  let leftAmt = 0;
  if ((motion.flags & MoveFlag.STRAFE_LEFT) !== 0) leftAmt += 1;
  if ((motion.flags & MoveFlag.STRAFE_RIGHT) !== 0) leftAmt -= 1;

  const dx = fwdAmt * fwdX * hp + leftAmt * -fwdY;
  const dy = fwdAmt * fwdY * hp + leftAmt * fwdX;
  const dz = fwdAmt * vp;

  // The speed the flags imply -- the reference's `GetCurrentSpeed` law: swimming picks the swim
  // pair, a net-backward move picks `min(runBack, run)`, a /walk-toggled mover picks walk, and
  // everything else runs. The `min` is the byte law, not a safety clamp.
  const backpedal = (motion.flags & MoveFlag.BACKWARD) !== 0
    && (motion.flags & MoveFlag.FORWARD) === 0;
  let base: number;
  if (swimming) {
    base = backpedal ? Math.min(speeds.swimBack, speeds.swim) : speeds.swim;
  } else if (backpedal) {
    base = Math.min(speeds.runBack, speeds.run);
  } else if ((motion.flags & MoveFlag.WALK_MODE) !== 0) {
    base = speeds.walk;
  } else {
    base = speeds.run;
  }

  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len > 1e-4) {
    const step = (base * dt) / len;
    motion.pos.x += dx * step;
    motion.pos.y += dy * step;
    motion.pos.z += dz * step;
    motion.speed = base;
  } else {
    motion.speed = 0;
  }

  out.copy(motion.pos);
  return motion.orientation;
}

/** How long this peer has been running on our extrapolation alone, ms. See `RUNAWAY_SILENCE_MS`. */
export function remoteSilentMs(motion: RemoteMotion, nowMs: number): number {
  return motion.fresh ? 0 : nowMs - motion.lastApplyMs;
}
