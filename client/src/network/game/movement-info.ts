import { GUID_BYTES, guidBytes } from '../guid-hex';
import Packet from '../net/packet';

/**
 * `MovementInfo` -- the one structure every 3.3.5a movement message is built out of, in ONE place.
 *
 * It appears three times on this wire and it was decoded twice, differently:
 *
 *  - `SMSG_UPDATE_OBJECT`'s UPDATEFLAG_LIVING block (`update-object/handler.ts#parseMovement`)
 *    decoded it in full, including every optional block;
 *  - the `MSG_MOVE_*` family (`object/player/movement.ts#handleMovement`) decoded a FIXED nine
 *    fields -- guid, flags, flags2, time, x, y, z, o, fallTime -- with no optional blocks at all.
 *    That is the common case and only the common case: a peer who is falling carries sixteen more
 *    bytes before `fallTime`'s successor, a peer on a boat carries a packed guid and six more
 *    fields, and a swimming peer carries a pitch. Reading past any of those returned nonsense
 *    coordinates, and since nothing downstream bounds-checked a position, a peer swimming in
 *    Northshire's stream would have been drawn at a garbage float.
 *  - the outbound side (`sendMovePacket`) WROTE a fourth shape again -- `writeByte(0)` where the
 *    wire wants a uint16 `flags2`, then no timestamp at all -- so the server read our flags2 out of
 *    the low half of our position. See `writeMovementInfo`.
 *
 * The order below is `WorldSession::ReadMovementInfo` / `Object::BuildMovementUpdate`'s LIVING arm,
 * and the two now share this function, so a defect found in one is fixed for both.
 *
 * WHAT THIS DOES NOT COVER: the LIVING block continues past this structure with nine speeds and an
 * optional spline; `MSG_MOVE_*` ends here. That split is the caller's, and it is why this returns
 * rather than reading on.
 */

/** 3.3.5a `MovementFlags`. Only the members this client acts on are named individually. */
export const MovementFlag = {
  NONE: 0x00000000,
  FORWARD: 0x00000001,
  BACKWARD: 0x00000002,
  STRAFE_LEFT: 0x00000004,
  STRAFE_RIGHT: 0x00000008,
  TURN_LEFT: 0x00000010,
  TURN_RIGHT: 0x00000020,
  PITCH_UP: 0x00000040,
  PITCH_DOWN: 0x00000080,
  WALKING: 0x00000100,
  ONTRANSPORT: 0x00000200,
  DISABLE_GRAVITY: 0x00000400,
  ROOT: 0x00000800,
  FALLING: 0x00001000,
  FALLING_FAR: 0x00002000,
  PENDING_STOP: 0x00004000,
  SWIMMING: 0x00200000,
  ASCENDING: 0x00400000,
  DESCENDING: 0x00800000,
  CAN_FLY: 0x01000000,
  FLYING: 0x02000000,
  SPLINE_ELEVATION: 0x04000000,
  SPLINE_ENABLED: 0x08000000,
  WATERWALKING: 0x10000000,
  FALLING_SLOW: 0x20000000,
  HOVER: 0x40000000,
} as const;

/** `MovementFlags2`. Only the two the wire layout branches on. */
export const MovementFlag2 = {
  NONE: 0x0000,
  ALWAYS_ALLOW_PITCHING: 0x0020,
  INTERPOLATED_MOVEMENT: 0x0400,
} as const;

/**
 * The mask of flags that mean "this unit is under its own power right now".
 *
 * Used by the peer interpolator to decide whether a position gap is travel to be walked out or a
 * relocation to be snapped: a peer with none of these set is standing, so any gap is a correction.
 */
export const MOVING_FLAGS = MovementFlag.FORWARD | MovementFlag.BACKWARD
  | MovementFlag.STRAFE_LEFT | MovementFlag.STRAFE_RIGHT
  | MovementFlag.ASCENDING | MovementFlag.DESCENDING
  | MovementFlag.FALLING | MovementFlag.SWIMMING | MovementFlag.FLYING;

export interface TransportInfo {
  guid: string;
  position: { x: number; y: number; z: number };
  facing: number;
  time: number;
  seat: number;
  time2?: number;
}

export interface MovementInfo {
  guid: string;
  flags: number;
  flags2: number;
  /** The sender's ms tick (`GetMSTime`), not a wall clock and not comparable across machines. */
  timeStamp: number;
  x: number;
  y: number;
  z: number;
  facing: number;
  transport: TransportInfo | null;
  pitch: number;
  fallTime: number;
  fallVelocity: number;
  fallSinAngle: number;
  fallCosAngle: number;
  fallSpeed: number;
  splineElevation: number;
}

/**
 * Read a `MovementInfo` including its packed-guid head.
 *
 * `hasGuid: false` is the `SMSG_UPDATE_OBJECT` LIVING case -- the guid was already read as the
 * update block's own head, and reading a second one there would eat the flags word.
 */
export function readMovementInfo(packet: Packet, hasGuid: boolean = true): MovementInfo {
  const info: MovementInfo = {
    guid: hasGuid ? packet.readPackedGUID() : '',
    flags: packet.readUnsignedInt() >>> 0,
    flags2: packet.readUnsignedShort(),
    timeStamp: packet.readUnsignedInt() >>> 0,
    x: packet.readFloat(),
    y: packet.readFloat(),
    z: packet.readFloat(),
    facing: packet.readFloat(),
    transport: null,
    pitch: 0,
    fallTime: 0,
    fallVelocity: 0,
    fallSinAngle: 0,
    fallCosAngle: 0,
    fallSpeed: 0,
    splineElevation: 0,
  };

  // MOVEMENTFLAG_ONTRANSPORT. NOT a fixed 21 bytes: the transport guid is PACKED, so the block is
  // 1..9 bytes of guid, four floats, a uint32 and an int8 -- plus one more uint32 when
  // MOVEMENTFLAG2_INTERPOLATED_MOVEMENT is set.
  if ((info.flags & MovementFlag.ONTRANSPORT) !== 0) {
    const transport: TransportInfo = {
      guid: packet.readPackedGUID(),
      position: packet.readVector3(),
      facing: packet.readFloat(),
      time: packet.readUnsignedInt(),
      seat: packet.readByte(),
    };
    if ((info.flags2 & MovementFlag2.INTERPOLATED_MOVEMENT) !== 0) {
      transport.time2 = packet.readUnsignedInt();
    }
    info.transport = transport;
  }

  if ((info.flags & MovementFlag.SWIMMING) !== 0
    || (info.flags & MovementFlag.FLYING) !== 0
    || (info.flags2 & MovementFlag2.ALWAYS_ALLOW_PITCHING) !== 0) {
    info.pitch = packet.readFloat();
  }

  info.fallTime = packet.readUnsignedInt() >>> 0;

  // MOVEMENTFLAG_FALLING: four floats, in the server's order -- jump velocity, sin, cos, then the
  // horizontal speed (`MovementInfo::JumpInfo`: zspeed, sinAngle, cosAngle, xyspeed).
  if ((info.flags & MovementFlag.FALLING) !== 0) {
    info.fallVelocity = packet.readFloat();
    info.fallSinAngle = packet.readFloat();
    info.fallCosAngle = packet.readFloat();
    info.fallSpeed = packet.readFloat();
  }

  if ((info.flags & MovementFlag.SPLINE_ELEVATION) !== 0) {
    info.splineElevation = packet.readFloat();
  }

  return info;
}

/** Everything `writeMovementInfo` needs; the optional blocks default to absent. */
export interface OutgoingMovement {
  guid: string;
  flags: number;
  flags2?: number;
  timeStamp: number;
  x: number;
  y: number;
  z: number;
  facing: number;
  pitch?: number;
  fallTime?: number;
  fallVelocity?: number;
  fallSinAngle?: number;
  fallCosAngle?: number;
  fallSpeed?: number;
}

/**
 * The exact mirror of `readMovementInfo` for the packets WE send.
 *
 * The old `sendMovePacket` wrote `writeUnsignedInt(flags)` then `writeByte(0)` then the position:
  * one byte where the wire wants a uint16 `flags2`, and NO `time` at all. So the server read our
 * flags2 from the low byte of the timestamp slot and our X out of the middle of nothing -- every
 * outbound movement message was three bytes short and misaligned from the third field on.
 *
 * The optional blocks matter as much as the fixed ones: 3.3.5a's `WorldSession::ReadMovementInfo`
 * reads the jump block whenever we claim MOVEMENTFLAG_FALLING, so sending the flag without the four
 * floats desyncs the server's read of the NEXT packet on the same stream.
 */
export function writeMovementInfo(packet: Packet, move: OutgoingMovement): void {
  const flags = move.flags >>> 0;
  const flags2 = (move.flags2 ?? 0) & 0xffff;

  packet.writePackedGUID(move.guid);
  packet.writeUnsignedInt(flags);
  packet.writeUnsignedShort(flags2);
  packet.writeUnsignedInt(move.timeStamp >>> 0);
  packet.writeFloat(move.x);
  packet.writeFloat(move.y);
  packet.writeFloat(move.z);
  packet.writeFloat(move.facing);

  // No ONTRANSPORT arm: this client never rides one, and claiming the flag without the block would
  // desync the server's read. If transports are ever driven from here, the block goes exactly here.
  if ((flags & MovementFlag.SWIMMING) !== 0
    || (flags & MovementFlag.FLYING) !== 0
    || (flags2 & MovementFlag2.ALWAYS_ALLOW_PITCHING) !== 0) {
    packet.writeFloat(move.pitch ?? 0);
  }

  packet.writeUnsignedInt((move.fallTime ?? 0) >>> 0);

  if ((flags & MovementFlag.FALLING) !== 0) {
    packet.writeFloat(move.fallVelocity ?? 0);
    packet.writeFloat(move.fallSinAngle ?? 0);
    packet.writeFloat(move.fallCosAngle ?? 0);
    packet.writeFloat(move.fallSpeed ?? 0);
  }
}

/**
 * The EXACT byte length `writeMovementInfo` will produce -- and it has to be exact, not an upper
 * bound.
 *
 * `GamePacket`'s buffer is FIXED-LENGTH: the constructor's numeric argument allocates, it does not
 * reserve, and `GameHandler#send` computes the declared packet size as `packet.bodySize + 4`, where
 * `bodySize` is `length - headerSize` -- the ALLOCATED length, not the written one. So a packet
 * allocated with slack is sent with that slack in it, declared as real payload, and the server
 * reads trailing zeroes as part of the message. Every outgoing packet in this client is sized this
 * way (`GameHandler#join` allocates `HEADER_SIZE_OUTGOING + GUID.LENGTH` and writes exactly eight
 * bytes), which is precisely why it works there and would not have worked here.
 *
 * The old `sendMovePacket` allocated `OPCODE_SIZE_OUTGOING + 4 + 1 + 4 + 2*4 + 4 + 8 + 6` -- 35
 * bytes, using the FOUR-byte opcode size where the SIX-byte header size belongs, for a body it
 * then wrote 29 bytes into. Two independent sizing errors in one expression.
 */
export function packedGuidSize(guid: string): number {
  // A mask byte plus one byte per non-zero guid byte -- exactly what `writePackedGUID` emits.
  let size = 1;
  const bytes = guidBytes(guid);
  for (let i = 0; i < GUID_BYTES; ++i) {
    if (bytes[i] !== 0) size += 1;
  }
  return size;
}

export function movementInfoSize(guid: string, flags: number, flags2: number = 0): number {
  let size = packedGuidSize(guid);
  size += 4 + 2 + 4 + 16; // flags, flags2, time, x/y/z/o
  if ((flags & MovementFlag.SWIMMING) !== 0
    || (flags & MovementFlag.FLYING) !== 0
    || (flags2 & MovementFlag2.ALWAYS_ALLOW_PITCHING) !== 0) {
    size += 4;
  }
  size += 4; // fallTime
  if ((flags & MovementFlag.FALLING) !== 0) {
    size += 16;
  }
  return size;
}
