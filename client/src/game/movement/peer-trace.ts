/**
 * The PEER motion instrument -- the one thing that can settle "the follower stalls and then speeds
 * up" without a second pair of eyes.
 *
 * Nothing on our own screen shows this defect: our body is drawn from the local mover and never from
 * the wire, so the whole failure lives in what an OBSERVER draws for somebody else. `moveWire`
 * (`network/game/object/player/movement.ts`) records what we SEND; this records what we DRAW for
 * everybody else, which is the other half of the same measurement.
 *
 * Three row kinds, deliberately in one stream so their timestamps interleave without a join:
 *
 *  - **`packet`** -- a `MSG_MOVE_*` arrived for this peer. `sinceMs` is the gap since his previous
 *    one, which is the number that made the old snapshot interpolator unstable: the sender emits a
 *    `SET_FACING` on every frame the facing changes (~33 ms) and a heartbeat only at 500 ms, so the
 *    gaps alternate short and long and a window guessed from the previous gap is wrong in both
 *    directions. `stepYd` is how far the packet moved him, i.e. the dead-reckon's error.
 *  - **`frame`** -- one INTEGRATION frame. `stepYd` is the per-frame displacement and `speed` is
 *    `stepYd / delta`.
 *  - **`render`** -- the transform actually on the scene graph after everything that writes it has
 *    run, read out of `view.matrixWorld`. THIS is the gate.
 *
 * WHY THE ROWS ARE DECOMPOSED, and it is the whole lesson of the round before this one. That round
 * measured a peer's motion as ONE SCALAR per frame -- `hypot(dx, dy, dz)` over the integration -- and
 * got p10/p50/p90 = 6.99999999996 / 6.99999999999 / 7.00000000004 yd/s over 1723 frames. Flawless,
 * and the owner still watched the peer teleport twice a second. The scalar could not show it: a
 * grounded dead-reckon's `dz` is IDENTICALLY ZERO (`net-motion.ts#advanceRemote`), so all the motion
 * the trace could see was the perfectly smooth XY, and the entire defect -- a 2 Hz height staircase --
 * lived in the Z the PACKET rows carried, reported as an aggregate "0.019-0.58 yd residual" and read
 * as evidence of good tracking. A measurement that sums axes cannot find a per-axis fault, and a
 * measurement of the integrator cannot find a fault in what is drawn. Hence `dxy` / `dz` split on
 * every row, and hence the `render` kind.
 *
 * Off by default and allocating nothing while off, so the calls can live in the per-frame path.
 * Turn it on with `window.peerTrace.enabled = true` and read `window.peerTrace.history()`.
 */
export interface PeerTraceRow {
  /** `performance.now()` at the record, ms. */
  at: number;
  kind: 'packet' | 'frame' | 'render';
  guid: string;
  flags: number;
  x: number;
  y: number;
  z: number;
  facing: number;
  /** `packet`: ms since this peer's previous packet. `frame`/`render`: the frame delta, ms. */
  sinceMs: number;
  /** Yards moved, all three axes. `packet`: by the snap; `frame`/`render`: since the previous one. */
  stepYd: number;
  /** The HORIZONTAL part of `stepYd`. Smooth on every kind, before and after this round's fix. */
  dxy: number;
  /** The VERTICAL part of `stepYd`, signed. This is where the half-second staircase was hiding. */
  dz: number;
  /** Yaw change (radians, signed, shortest arc) since the previous row of this kind for this guid. */
  dyaw: number;
  /** `frame`/`render`: `stepYd` over the frame delta, yd/s. */
  speed: number;
  /** The gait speed the selector is being told, yd/s -- what drives walk vs run vs stand. */
  gaitSpeed: number;
  /** `render` only: the `AnimationData` id playing, and its playback rate. -1 when nothing is armed. */
  seqId?: number;
  rate?: number;
}

const HISTORY = 8000;

/** Shortest signed angle, so a wrap does not read as a 2pi jump. Duplicated to keep this leaf-only. */
function wrapPi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

class PeerTrace {
  enabled = false;

  /**
   * A/B SWITCH: skip the world resolve on a peer's dead-reckoned step, restoring the pre-fix
   * behaviour on demand (`Unit#updateRemoteMotion` reads it).
   *
   * The reference keeps the same switch for the same reason -- `flat_extrapolation()`,
   * `samples/benilla/crates/benilla/src/net/motion/remote.rs:225-230`, whose doc says it "restores
   * both defects on demand (a watched player sinking into rising ground and floating over falling
   * ground; a mover marching into the wall its own client is stopped at), which is what makes the fix
   * measurable side by side rather than asserted".
   *
   * That is not a nicety here. The terrain a peer happens to be walking over decides how big the
   * height staircase is, so a before-run and an after-run on different ground are not comparable, and
   * this project has already had one movement claim voided by exactly that. Interleaving the two modes
   * inside ONE session over the SAME ground is the only honest comparison, and it needs a switch.
   */
  flatExtrapolation = false;

  private rows: PeerTraceRow[] = [];

  /** Previous `render` sample per guid, so `render` rows carry their own deltas. */
  private lastRender = new Map<string, { at: number; x: number; y: number; z: number; yaw: number }>();

  record(row: PeerTraceRow): void {
    if (!this.enabled) {
      return;
    }
    this.rows.push(row);
    if (this.rows.length > HISTORY) {
      this.rows.shift();
    }
  }

  /**
   * Sample the transform ACTUALLY RENDERED for a unit: `view.matrixWorld`'s translation and the yaw
   * its basis carries, differenced against this guid's previous sample.
   *
   * Read from the matrix rather than from `view.position` / `view.rotation` on purpose. Those are the
   * inputs; the matrix is what the draw call uses, and the previous round's whole failure was
   * measuring an input. Call it AFTER the frame's matrix update.
   */
  recordRender(
    guid: string,
    matrixWorld: { elements: ArrayLike<number> },
    flags: number,
    gaitSpeed: number,
    seqId: number,
    rate: number,
  ): void {
    if (!this.enabled) {
      return;
    }
    const e = matrixWorld.elements;
    const x = e[12];
    const y = e[13];
    const z = e[14];
    // Yaw out of the rotation basis: the first column is the model's local +X in world space, and
    // `view.rotation.z` is the only rotation anything writes on these objects.
    const yaw = Math.atan2(e[1], e[0]);
    const at = performance.now();
    const prev = this.lastRender.get(guid);
    this.lastRender.set(guid, { at, x, y, z, yaw });

    const dxy = prev ? Math.hypot(x - prev.x, y - prev.y) : 0;
    const dz = prev ? z - prev.z : 0;
    const sinceMs = prev ? at - prev.at : 0;
    const stepYd = Math.hypot(dxy, dz);
    this.record({
      at,
      kind: 'render',
      guid,
      flags,
      x,
      y,
      z,
      facing: yaw,
      sinceMs,
      stepYd,
      dxy,
      dz,
      dyaw: prev ? wrapPi(yaw - prev.yaw) : 0,
      speed: sinceMs > 0 ? stepYd / (sinceMs / 1000) : 0,
      gaitSpeed,
      seqId,
      rate,
    });
  }

  history(): readonly PeerTraceRow[] {
    return this.rows;
  }

  clear(): void {
    this.rows.length = 0;
    this.lastRender.clear();
  }
}

export const peerTrace = new PeerTrace();

if (typeof window !== 'undefined') {
  (window as any).peerTrace = peerTrace;
}
