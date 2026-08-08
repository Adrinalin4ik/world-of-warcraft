/**
 * A per-guid record of what the object stream did to each unit: created it, streamed it out, or
 * streamed it back in.
 *
 * Built because "NPCs vanish and never come back" has two completely different causes that look
 * identical from the outside -- the server stopping sending, or us stopping processing -- and the
 * only way to tell them apart is to see the blocks arrive with their guids attached. `moveWire`
 * (`object/player/movement.ts:73-99`) is the same shape and exists for the same reason on the
 * outbound side; this is its inbound counterpart.
 *
 * OFF by default and one branch when off, per the standing rule in this project that an instrument
 * must not cost anything in a normal session. `window.objectTrace.enabled = true` arms it.
 */
export type ObjectTraceKind =
  /** A `CreateObject1`/`CreateObject2` block. `existing` says whether the guid was already known. */
  | 'create'
  /** An `OutOfRange` block naming this guid -- the server says we have left its range. */
  | 'far'
  /** A `NearObjects` block naming this guid. 3.3.5 servers are not observed to send these. */
  | 'near'
  /** `SMSG_DESTROY_OBJECT` -- the object ceased to exist (a despawn, a decaying corpse). */
  | 'destroy';

export interface ObjectTraceRow {
  /** `performance.now()` at the moment the block was applied. */
  t: number;
  kind: ObjectTraceKind;
  guid: string;
  /** Was this guid already in `World#entities` when the block arrived? */
  existing?: boolean;
  /** For `create`: whether the unit's `view.visible` was true immediately after it was applied. */
  visible?: boolean;
}

class ObjectTrace {
  enabled = false;

  private rows: ObjectTraceRow[] = [];

  private limit = 4000;

  record(row: ObjectTraceRow): void {
    if (!this.enabled) {
      return;
    }
    this.rows.push(row);
    if (this.rows.length > this.limit) {
      this.rows.shift();
    }
  }

  history(): readonly ObjectTraceRow[] {
    return this.rows;
  }

  clear(): void {
    this.rows.length = 0;
  }
}

export const objectTrace = new ObjectTrace();

if (typeof window !== 'undefined') {
  (window as any).objectTrace = objectTrace;
}
