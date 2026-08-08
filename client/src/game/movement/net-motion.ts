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
 *  - **A peer player's `MSG_MOVE_*`** is a single position at message cadence, with no statement
 *    about the future at all. Drawing it directly is a teleport every few hundred ms. So the peer
 *    is drawn BEHIND the wire: each message opens a short interpolation from where we are drawing
 *    him to where the server says he is, over the OBSERVED interval between his own messages
 *    (`advanceRemote`). That is snapshot interpolation with a one-packet buffer -- it trades a
 *    fixed sub-packet latency for continuous motion, which is the trade the real client makes too.
 *    It deliberately does NOT extrapolate along the movement flags: dead reckoning overshoots every
 *    stop, and a peer sliding through a wall past his own stopping point looks far worse than a
 *    peer arriving a fifth of a second late.
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
 * Minimum and maximum interpolation window (ms) for a peer's `MSG_MOVE_*` stream.
 *
 * The window is the OBSERVED interval between that peer's own messages, clamped. The floor stops a
 * burst of coalesced messages collapsing the window to a single frame (which is a teleport again);
 * the ceiling stops a peer who went quiet for two seconds from then crawling for two seconds when
 * he speaks again -- past it, we are better off snapping and being right.
 */
export const REMOTE_WINDOW_MIN_MS = 80;
export const REMOTE_WINDOW_MAX_MS = 500;

/**
 * Beyond this gap (yd) a peer's new position is a RELOCATION, not travel: a worldport, a spawn, or
 * simply the first message after he walked out of and back into our grid. Interpolating it would
 * drag the body across the zone in a straight line through everything in between.
 *
 * 40 yd is well past what a peer can cover in `REMOTE_WINDOW_MAX_MS` at any 3.3.5a speed (the fast
 * flight speed is 32 yd/s, so half a second is 16 yd) and well short of a real relocation.
 */
export const REMOTE_SNAP_DISTANCE = 40;

/** A peer's `MSG_MOVE_*` stream, interpolated. */
export interface RemoteMotion {
  from: THREE.Vector3;
  to: THREE.Vector3;
  facingFrom: number;
  facingTo: number;
  startedMs: number;
  windowMs: number;
  /** `performance.now()` of the previous message, for measuring the window. 0 before the first. */
  lastMessageMs: number;
  /** The peer's movement flags as of the last message. */
  flags: number;
}

export function createRemoteMotion(): RemoteMotion {
  return {
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    facingFrom: 0,
    facingTo: 0,
    startedMs: 0,
    windowMs: REMOTE_WINDOW_MIN_MS,
    lastMessageMs: 0,
    flags: 0,
  };
}

/** Shortest signed angle, so a facing never eases the long way round. */
export function wrapPi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Take one wire position for a peer. `current` is where he is being DRAWN right now, which becomes
 * the interpolation's start -- not his last wire position, so a message arriving mid-window does not
 * jerk him back.
 *
 * Returns true if the caller should SNAP (the gap was a relocation, or this is the first message).
 */
export function acceptRemoteState(
  motion: RemoteMotion,
  current: THREE.Vector3,
  currentFacing: number,
  to: { x: number; y: number; z: number },
  facing: number,
  flags: number,
  nowMs: number,
): boolean {
  const first = motion.lastMessageMs === 0;
  const measured = first ? REMOTE_WINDOW_MIN_MS : nowMs - motion.lastMessageMs;
  motion.lastMessageMs = nowMs;
  motion.flags = flags;

  const gap = Math.hypot(to.x - current.x, to.y - current.y, to.z - current.z);
  if (first || gap > REMOTE_SNAP_DISTANCE) {
    motion.from.set(to.x, to.y, to.z);
    motion.to.set(to.x, to.y, to.z);
    motion.facingFrom = facing;
    motion.facingTo = facing;
    motion.startedMs = nowMs;
    motion.windowMs = REMOTE_WINDOW_MIN_MS;
    return true;
  }

  motion.from.copy(current);
  motion.to.set(to.x, to.y, to.z);
  motion.facingFrom = currentFacing;
  motion.facingTo = facing;
  motion.startedMs = nowMs;
  motion.windowMs = Math.min(REMOTE_WINDOW_MAX_MS, Math.max(REMOTE_WINDOW_MIN_MS, measured));
  return false;
}

/**
 * Advance a peer one frame. Writes `out` and returns the interpolated facing.
 *
 * Past the window the peer sits at the last wire position rather than drifting on: a peer we have
 * stopped hearing from has stopped, as far as we can honestly say.
 */
export function advanceRemote(
  motion: RemoteMotion,
  nowMs: number,
  out: THREE.Vector3,
): number {
  const t = motion.windowMs > 0
    ? Math.min(1, Math.max(0, (nowMs - motion.startedMs) / motion.windowMs))
    : 1;
  out.copy(motion.from).lerp(motion.to, t);
  return motion.facingFrom + wrapPi(motion.facingTo - motion.facingFrom) * t;
}
