import { guidHex } from '../../../guid-hex';
import Packet from '../../../net/packet';

/**
 * `SMSG_MONSTER_MOVE` / `SMSG_MONSTER_MOVE_TRANSPORT` -- the server-dictated creature path.
 *
 * A pure function over a `Packet`, separated from the handler so the one test in this task can feed
 * it a RECORDED body and assert on the decoded path and timing.
 *
 * ================== HOW THIS LAYOUT WAS ESTABLISHED, because it was not by reading a wiki ========
 *
 * 642 real `SMSG_MONSTER_MOVE` bodies were captured from `logon.gladewow.ru` during a 75 s world
 * entry as `Gesf` at Northshire (`mm-capture.js`), then every candidate layout was scored offline
 * against the ONE oracle a packet decoder has: the body must be consumed EXACTLY. A hypothesis that
 * leaves bytes over, or runs off the end, is wrong, and with 642 samples the survivor is unique.
 *
 * Measured (`mm-analyse.js`):
 *   - 642 packets, 0 stops, move types {0: 628, 4: 14} (14 carried a final facing ANGLE);
 *   - the ONLY spline-flag bits ever set were bit 12 (0x1000) on 202 of them, and nothing else.
 *     So `Animation`, `Parabolic`, `Flying` and `Catmullrom` were NOT exercised by this deploy --
 *     see the fallback below, which is how this decoder stays honest about that;
 *   - of the 642, 452 admit exactly ONE layout and 190 are degenerate (a one-point path, where every
 *     candidate coincides). The unique survivor is: no animation block, no parabolic block, and a
 *     LINEAR path whose packed-offset count is `count - 1`.
 *
 * And (`mm-analyse2.js`, on the 170 packets with three or more points) the packed offsets are
 * relative to the MIDPOINT of (start, destination) and SUBTRACTED, not added -- the four candidates
 * scored, by the ratio of reconstructed path length to the straight-line start->destination
 * distance and by the implied speed:
 *
 *     mid - off   len/direct 1.002   speed 2.50 yd/s   <-- a real walk
 *     mid + off   len/direct 2.064   speed 5.13
 *     dest - off  len/direct 1.679   speed 4.15
 *     dest + off  len/direct 2.064   speed 5.13
 *
 * 2.50 yd/s is exactly the creature WALK speed, and a patrol path 0.2% longer than its own chord is
 * a walk down a road. The other three are the same walk read wrong. The old handler in this
 * directory did `mid + offset` and was never subscribed, so nothing had ever exercised it.
 *
 * =================================================================================================
 */

/** `MonsterMoveType`. `Stop` ends the packet after the type byte -- there is no tail at all. */
export const MonsterMoveType = {
  Normal: 0,
  Stop: 1,
  FacingSpot: 2,
  FacingTarget: 3,
  FacingAngle: 4,
} as const;

export interface MonsterMoveFacing {
  kind: 'none' | 'spot' | 'target' | 'angle';
  spot?: { x: number; y: number; z: number };
  target?: string;
  angle?: number;
}

export interface MonsterMove {
  guid: string;
  transportGuid: string | null;
  transportSeat: number;
  /** The path's first point, straight off the wire. */
  start: { x: number; y: number; z: number };
  splineId: number;
  facing: MonsterMoveFacing;
  splineFlags: number;
  /** Milliseconds the unit takes to walk the whole path. 0 for a stop. */
  durationMs: number;
  /** Full travel-order polyline `[start, ...waypoints, destination]`. Empty for a stop. */
  path: { x: number; y: number; z: number }[];
  /** The path is a 3-D curve rather than a ground walk (see `catmullRom` below). */
  flying: boolean;
  stop: boolean;
}

/**
 * A quarter-yard packed XYZ offset: 11 bits X, 11 bits Y, 10 bits Z, each signed.
 *
 * `>>>` first, then `<< n >> n`, because a raw `>>` on the top field of a value with bit 31 set
 * would sign-extend the wrong field. Sign extension is by shifting the field to the top of the
 * int32 and back down, which is the only way to do it for widths JS has no type for.
 */
function unpackOffset(packed: number): { x: number; y: number; z: number } {
  return {
    x: (((packed & 0x7ff) << 21) >> 21) * 0.25,
    y: ((((packed >>> 11) & 0x7ff) << 21) >> 21) * 0.25,
    z: ((((packed >>> 22) & 0x3ff) << 22) >> 22) * 0.25,
  };
}

/**
 * The unverified-layout warning, fired at most once per distinct flags word.
 *
 * A gap that cannot be closed goes through an explicit warning rather than a silent no-op: the
 * `Animation`, `Parabolic` and `Flying`/`Catmullrom` arms of this packet were NEVER observed on
 * this server, so their exact flag-bit VALUES are not pinned by anything here. Rather than assert a
 * bit number no measurement supports, `readMonsterMove` decodes the verified layout and, if that
 * does not consume the body exactly, re-tries the small space of documented variants and reports
 * which one fitted along with the flags word that selected it. The first such log pins the bit.
 */
const warnedFlags = new Set<number>();

function warnUnverified(flags: number, fitted: string) {
  if (warnedFlags.has(flags)) {
    return;
  }
  warnedFlags.add(flags);
  console.warn(
    `SMSG_MONSTER_MOVE: spline flags 0x${(flags >>> 0).toString(16)} did not fit the measured`
    + ` layout; fell back to "${fitted}". This arm is UNVERIFIED on this server -- the bit values`
    + ' for Animation / Parabolic / Flying were never observed in the 642-packet capture that'
    + ' pinned the rest. Record this line: it is the measurement that pins them.',
  );
}

/** One candidate tail layout: how many extra bytes before/after the duration, and the path form. */
interface TailShape {
  name: string;
  animation: boolean;
  parabolic: boolean;
  catmullRom: boolean;
}

const VERIFIED_SHAPE: TailShape = {
  name: 'linear', animation: false, parabolic: false, catmullRom: false,
};

/** The documented variants, tried only when the verified one does not consume the body exactly. */
const FALLBACK_SHAPES: TailShape[] = [
  { name: 'catmull-rom', animation: false, parabolic: false, catmullRom: true },
  { name: 'parabolic+linear', animation: false, parabolic: true, catmullRom: false },
  { name: 'animation+linear', animation: true, parabolic: false, catmullRom: false },
  { name: 'parabolic+catmull-rom', animation: false, parabolic: true, catmullRom: true },
  { name: 'animation+catmull-rom', animation: true, parabolic: false, catmullRom: true },
  { name: 'animation+parabolic+linear', animation: true, parabolic: true, catmullRom: false },
];

/** Bytes the tail would consume from `at` under `shape`, or -1 if it cannot be read at all. */
function tailSize(packet: Packet, at: number, shape: TailShape): number {
  const end = packet.length;
  let i = at;
  if (shape.animation) i += 5; // uint8 animation id + int32 effect start time
  if (i + 4 > end) return -1;
  i += 4; // duration
  if (shape.parabolic) i += 8; // float vertical acceleration + int32 effect start time
  if (i + 4 > end) return -1;
  const count = readUint32At(packet, i);
  i += 4;
  if (count > 0xffff) return -1;
  if (shape.catmullRom) {
    return i + count * 12 - at;
  }
  if (count === 0) {
    return i - at;
  }
  // Destination (absolute) + `count - 1` packed offsets. `count` is the producer's `last_idx`, the
  // index of the destination in its own path array, so the interior points are 1..count-1.
  return i + 12 + Math.max(0, count - 1) * 4 - at;
}

function readUint32At(packet: Packet, at: number): number {
  const saved = packet.index;
  packet.index = at;
  const value = packet.readUnsignedInt() >>> 0;
  packet.index = saved;
  return value;
}

/** Read the tail under a shape, from the current cursor. */
function readTail(packet: Packet, shape: TailShape, start: { x: number; y: number; z: number }) {
  if (shape.animation) {
    packet.readUnsignedByte();
    packet.readInt();
  }
  const durationMs = packet.readInt();
  if (shape.parabolic) {
    packet.readFloat();
    packet.readInt();
  }
  const count = packet.readUnsignedInt() >>> 0;
  const path: { x: number; y: number; z: number }[] = [start];

  if (shape.catmullRom) {
    for (let i = 0; i < count; ++i) {
      path.push(packet.readVector3());
    }
    return { durationMs, path };
  }

  if (count === 0) {
    return { durationMs, path: [] };
  }

  const destination = packet.readVector3();
  const mid = {
    x: (start.x + destination.x) * 0.5,
    y: (start.y + destination.y) * 0.5,
    z: (start.z + destination.z) * 0.5,
  };
  for (let i = 0; i < count - 1; ++i) {
    const offset = unpackOffset(packet.readInt());
    path.push({ x: mid.x - offset.x, y: mid.y - offset.y, z: mid.z - offset.z });
  }
  path.push(destination);
  return { durationMs, path };
}

/**
 * `Mask_CatmullRom`. UNVERIFIED -- see `warnUnverified`. Used only as a HINT for which fallback to
 * try first; the byte-exactness check, not this constant, is what actually decides.
 */
const SPLINE_FLAG_CATMULLROM_HINT = 0x00002000 | 0x00040000;

/**
 * @param hasTransport true for `SMSG_MONSTER_MOVE_TRANSPORT`, which prefixes a transport guid and
 * seat. The two opcodes are otherwise identical.
 */
export function readMonsterMove(packet: Packet, hasTransport: boolean = false): MonsterMove | null {
  const guid = packet.readPackedGUID();
  const transportGuid = hasTransport ? packet.readPackedGUID() : null;
  const transportSeat = hasTransport ? packet.readUnsignedByte() : 0;

  // `WriteCommonMonsterMovePart` opens with `uint8(0)` -- it sets/unsets MOVEMENTFLAG2_UNK7 on the
  // client. Present in all 642 captured packets, always before the position.
  packet.readUnsignedByte();

  const start = packet.readVector3();
  const splineId = packet.readUnsignedInt() >>> 0;
  const moveType = packet.readUnsignedByte();

  const facing: MonsterMoveFacing = { kind: 'none' };
  if (moveType === MonsterMoveType.FacingSpot) {
    facing.kind = 'spot';
    facing.spot = packet.readVector3();
  } else if (moveType === MonsterMoveType.FacingTarget) {
    facing.kind = 'target';
    // A FULL uint64, not a packed guid, exactly as the spline block in `SMSG_UPDATE_OBJECT` writes
    // it. Routed through the SHARED formatter so it is the same normalised lowercase hex string
    // every other guid in this client is -- a hand-rolled one here would not compare equal to a
    // packed guid for the same unit, which is the exact defect `network/guid-hex.ts` exists to end.
    const bytes = new Uint8Array(8);
    const low = packet.readUnsignedInt() >>> 0;
    const high = packet.readUnsignedInt() >>> 0;
    for (let i = 0; i < 4; ++i) {
      bytes[i] = (low >>> (i * 8)) & 0xff;
      bytes[i + 4] = (high >>> (i * 8)) & 0xff;
    }
    facing.target = guidHex(bytes);
  } else if (moveType === MonsterMoveType.FacingAngle) {
    facing.kind = 'angle';
    facing.angle = packet.readFloat();
  }

  if (moveType === MonsterMoveType.Stop) {
    // `PacketBuilder::WriteStopMovement` ends here: no flags, no duration, no points. Reading a
    // tail anyway over-runs the body and the whole packet is dropped -- which looks exactly like a
    // creature freezing where it stands.
    return {
      guid,
      transportGuid,
      transportSeat,
      start,
      splineId,
      facing,
      splineFlags: 0,
      durationMs: 0,
      path: [],
      flying: false,
      stop: true,
    };
  }

  const splineFlags = packet.readUnsignedInt() >>> 0;
  const at = packet.index;

  let shape: TailShape | null = tailSize(packet, at, VERIFIED_SHAPE) === packet.length - at
    ? VERIFIED_SHAPE
    : null;

  if (!shape) {
    const ordered = (splineFlags & SPLINE_FLAG_CATMULLROM_HINT) !== 0
      ? FALLBACK_SHAPES
      : FALLBACK_SHAPES.slice().reverse();
    shape = ordered.find((s) => tailSize(packet, at, s) === packet.length - at) ?? null;
    if (!shape) {
      console.warn(
        `SMSG_MONSTER_MOVE: no known tail layout consumes the body exactly (flags`
        + ` 0x${splineFlags.toString(16)}, ${packet.length - at} bytes left). Dropped -- guid`
        + ` ${guid} will hold its position until its next move.`,
      );
      return null;
    }
    warnUnverified(splineFlags, shape.name);
  }

  const { durationMs, path } = readTail(packet, shape, start);

  return {
    guid,
    transportGuid,
    transportSeat,
    start,
    splineId,
    facing,
    splineFlags,
    durationMs,
    path,
    flying: shape.catmullRom,
    stop: false,
  };
}
