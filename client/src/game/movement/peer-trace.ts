/**
 * The PEER motion instrument -- the one thing that can settle "the follower stalls and then speeds
 * up" without a second pair of eyes.
 *
 * Nothing on our own screen shows this defect: our body is drawn from the local mover and never from
 * the wire, so the whole failure lives in what an OBSERVER draws for somebody else. `moveWire`
 * (`network/game/object/player/movement.ts`) records what we SEND; this records what we DRAW for
 * everybody else, which is the other half of the same measurement.
 *
 * Two row kinds, deliberately in one stream so their timestamps interleave without a join:
 *
 *  - **`packet`** -- a `MSG_MOVE_*` arrived for this peer. `sinceMs` is the gap since his previous
 *    one, which is the number that made the old snapshot interpolator unstable: the sender emits a
 *    `SET_FACING` on every frame the facing changes (~33 ms) and a heartbeat only at 500 ms, so the
 *    gaps alternate short and long and a window guessed from the previous gap is wrong in both
 *    directions. `snapYd` is how far the packet moved him, i.e. the dead-reckon's error.
 *  - **`frame`** -- one drawn frame. `stepYd` is the per-frame displacement and `speed` is
 *    `stepYd / delta`. THIS is the gate: a stall-then-rush shows as a run of near-zero `speed` rows
 *    followed by a spike, and smooth motion shows as a flat line at his gait speed.
 *
 * Off by default and allocating nothing while off, so the two calls can live in the per-frame path.
 * Turn it on with `window.peerTrace.enabled = true` and read `window.peerTrace.history()`.
 */
export interface PeerTraceRow {
  /** `performance.now()` at the record, ms. */
  at: number;
  kind: 'packet' | 'frame';
  guid: string;
  flags: number;
  x: number;
  y: number;
  z: number;
  facing: number;
  /** `packet`: ms since this peer's previous packet. `frame`: the frame delta, ms. */
  sinceMs: number;
  /** `packet`: yards the packet moved him. `frame`: yards drawn this frame. */
  stepYd: number;
  /** `frame` only: `stepYd` over the frame delta, yd/s. */
  speed: number;
  /** The gait speed the selector is being told, yd/s -- what drives walk vs run vs stand. */
  gaitSpeed: number;
}

const HISTORY = 4000;

class PeerTrace {
  enabled = false;

  private rows: PeerTraceRow[] = [];

  record(row: PeerTraceRow): void {
    if (!this.enabled) {
      return;
    }
    this.rows.push(row);
    if (this.rows.length > HISTORY) {
      this.rows.shift();
    }
  }

  history(): readonly PeerTraceRow[] {
    return this.rows;
  }

  clear(): void {
    this.rows.length = 0;
  }
}

export const peerTrace = new PeerTrace();

if (typeof window !== 'undefined') {
  (window as any).peerTrace = peerTrace;
}
