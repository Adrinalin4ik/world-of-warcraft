import EventEmitter from 'events';
import { setMovementSink } from '../../../../game/movement/outbound';
import { PlayerMoveState } from '../../../../game/movement/player-state';
import { GameHandler } from '../../handler';
import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import {
  MovementFlag, movementInfoSize, packedGuidSize, readMovementInfo, writeMovementInfo,
} from '../../movement-info';

/**
 * The `MSG_MOVE_*` family, both directions.
 *
 * INBOUND these are relays: the server forwards a peer's movement message verbatim, so the body is
 * a packed guid followed by a `MovementInfo` and the OPCODE is the only thing that says what
 * happened. This client draws positions, not intents, so every one of them is decoded the same way
 * and handed to the peer interpolator; the opcode is kept for the trace.
 *
 * OUTBOUND these are ours, and they are edge-driven: the real client sends a START on the frame a
 * flag turns on, a STOP on the frame the last translation flag turns off, a SET_FACING on a turn
 * with no translation, and a HEARTBEAT roughly twice a second in between. The server's movement
 * handler validates position deltas against the elapsed time, so a client that sends only
 * heartbeats -- or nothing at all, which is what this client did until now -- has a server-side
 * position that never leaves the login point.
 *
 * WHAT IS NOT HANDLED, said plainly rather than left as a silent gap:
 *  - MSG_MOVE_TELEPORT / MSG_MOVE_TELEPORT_ACK: a server-driven relocation of OUR character. The
 *    ack is sent (below), because not acking wedges the server's teleport state machine, but the
 *    local mover is not moved to the destination -- `Unit#teleportTo` and the settle hold are the
 *    machinery for that and wiring them here needs the world's map-change path, which is not in
 *    this task.
 *  - MSG_MOVE_KNOCK_BACK / SMSG_MOVE_KNOCK_BACK: the server pushing us. Warned, not applied.
 *  - the `*_CHEAT` variants, transports (`MSG_MOVE_CHNG_TRANSPORT`), vehicles, and pitch
 *    (`MSG_MOVE_SET_PITCH`) outside swimming.
 */

/** How often a moving character re-states its position. The reference client's cadence is ~500 ms. */
const HEARTBEAT_MS = 500;

/** Facing change (radians) below which a turn is not worth a packet. ~0.6 degrees. */
const FACING_EPSILON = 0.01;

/** Flags whose edges are announced with their own opcode, and which opcode. */
const START_OPCODES: [number, number][] = [
  [MovementFlag.FORWARD, GameOpcode.MSG_MOVE_START_FORWARD],
  [MovementFlag.BACKWARD, GameOpcode.MSG_MOVE_START_BACKWARD],
  [MovementFlag.STRAFE_LEFT, GameOpcode.MSG_MOVE_START_STRAFE_LEFT],
  [MovementFlag.STRAFE_RIGHT, GameOpcode.MSG_MOVE_START_STRAFE_RIGHT],
  [MovementFlag.TURN_LEFT, GameOpcode.MSG_MOVE_START_TURN_LEFT],
  [MovementFlag.TURN_RIGHT, GameOpcode.MSG_MOVE_START_TURN_RIGHT],
];

const TRANSLATE_MASK = MovementFlag.FORWARD | MovementFlag.BACKWARD;
const STRAFE_MASK = MovementFlag.STRAFE_LEFT | MovementFlag.STRAFE_RIGHT;
const TURN_MASK = MovementFlag.TURN_LEFT | MovementFlag.TURN_RIGHT;

/** The inbound relays this client acts on. All of them decode identically; see the class docs. */
const RELAYED = [
  'MSG_MOVE_START_FORWARD',
  'MSG_MOVE_START_BACKWARD',
  'MSG_MOVE_STOP',
  'MSG_MOVE_START_STRAFE_LEFT',
  'MSG_MOVE_START_STRAFE_RIGHT',
  'MSG_MOVE_STOP_STRAFE',
  'MSG_MOVE_JUMP',
  'MSG_MOVE_START_TURN_LEFT',
  'MSG_MOVE_START_TURN_RIGHT',
  'MSG_MOVE_STOP_TURN',
  'MSG_MOVE_START_PITCH_UP',
  'MSG_MOVE_START_PITCH_DOWN',
  'MSG_MOVE_STOP_PITCH',
  'MSG_MOVE_SET_RUN_MODE',
  'MSG_MOVE_SET_WALK_MODE',
  'MSG_MOVE_FALL_LAND',
  'MSG_MOVE_START_SWIM',
  'MSG_MOVE_STOP_SWIM',
  'MSG_MOVE_SET_FACING',
  'MSG_MOVE_SET_PITCH',
  'MSG_MOVE_HEARTBEAT',
  'MSG_MOVE_START_ASCEND',
  'MSG_MOVE_STOP_ASCEND',
  'MSG_MOVE_START_DESCEND',
  'MSG_MOVE_ROOT',
  'MSG_MOVE_UNROOT',
];

/**
 * The speed relays. `MSG_MOVE_SET_*_SPEED` is a peer's speed change (5 of them landed in the
 * recorded entry burst); `SMSG_FORCE_*_SPEED_CHANGE` is OUR speed being set and MUST be acked or
 * the server resends it and eventually treats us as unresponsive.
 */
const SPEED_RELAYS: [string, keyof SpeedSet][] = [
  ['MSG_MOVE_SET_WALK_SPEED', 'walk'],
  ['MSG_MOVE_SET_RUN_SPEED', 'run'],
  ['MSG_MOVE_SET_RUN_BACK_SPEED', 'runBack'],
  ['MSG_MOVE_SET_SWIM_SPEED', 'swim'],
  ['MSG_MOVE_SET_SWIM_BACK_SPEED', 'swimBack'],
  ['MSG_MOVE_SET_FLIGHT_SPEED', 'flight'],
  ['MSG_MOVE_SET_FLIGHT_BACK_SPEED', 'flightBack'],
  ['MSG_MOVE_SET_TURN_RATE', 'turn'],
  ['MSG_MOVE_SET_PITCH_RATE', 'pitch'],
];

interface SpeedSet {
  walk: number; run: number; runBack: number; swim: number; swimBack: number;
  flight: number; flightBack: number; turn: number; pitch: number;
}

/** `SMSG_FORCE_*_SPEED_CHANGE` -> the ack we owe the server. */
const FORCE_ACKS: [string, number][] = [
  ['SMSG_FORCE_WALK_SPEED_CHANGE', GameOpcode.CMSG_FORCE_WALK_SPEED_CHANGE_ACK],
  ['SMSG_FORCE_RUN_SPEED_CHANGE', GameOpcode.CMSG_FORCE_RUN_SPEED_CHANGE_ACK],
  ['SMSG_FORCE_RUN_BACK_SPEED_CHANGE', GameOpcode.CMSG_FORCE_RUN_BACK_SPEED_CHANGE_ACK],
  ['SMSG_FORCE_SWIM_SPEED_CHANGE', GameOpcode.CMSG_FORCE_SWIM_SPEED_CHANGE_ACK],
  ['SMSG_FORCE_SWIM_BACK_SPEED_CHANGE', GameOpcode.CMSG_FORCE_SWIM_BACK_SPEED_CHANGE_ACK],
  ['SMSG_FORCE_FLIGHT_SPEED_CHANGE', GameOpcode.CMSG_FORCE_FLIGHT_SPEED_CHANGE_ACK],
  ['SMSG_FORCE_FLIGHT_BACK_SPEED_CHANGE', GameOpcode.CMSG_FORCE_FLIGHT_BACK_SPEED_CHANGE_ACK],
  ['SMSG_FORCE_TURN_RATE_CHANGE', GameOpcode.CMSG_FORCE_TURN_RATE_CHANGE_ACK],
  ['SMSG_FORCE_PITCH_RATE_CHANGE', GameOpcode.CMSG_FORCE_PITCH_RATE_CHANGE_ACK],
  ['SMSG_FORCE_MOVE_ROOT', GameOpcode.CMSG_FORCE_MOVE_ROOT_ACK],
  ['SMSG_FORCE_MOVE_UNROOT', GameOpcode.CMSG_FORCE_MOVE_UNROOT_ACK],
];

export class PlayerMovementHandler extends EventEmitter {
  private game: GameHandler;

  /** Last flag word actually sent, so only EDGES produce a packet. */
  private sentFlags = 0;

  private lastSentFacing = 0;

  private lastHeartbeatMs = 0;

  /** Counters the world-state probe reads to prove the outbound stream is real. */
  public sent = { total: 0, heartbeats: 0, starts: 0, stops: 0, facings: 0, jumps: 0, lands: 0 };

  public received = { relays: 0, speeds: 0, acks: 0, unhandled: 0 };

  constructor(gameHandler: GameHandler) {
    super();
    this.game = gameHandler;

    RELAYED.forEach((name) => {
      this.game.on(`packet:receive:${name}`, this.handleRelay.bind(this));
    });
    SPEED_RELAYS.forEach(([name, key]) => {
      this.game.on(`packet:receive:${name}`, (packet: GamePacket) => this.handleSpeed(packet, key));
    });
    FORCE_ACKS.forEach(([name, ackOpcode]) => {
      this.game.on(`packet:receive:${name}`, (packet: GamePacket) => this.handleForce(packet, ackOpcode));
    });
    this.game.on('packet:receive:MSG_MOVE_TELEPORT_ACK', this.handleTeleport.bind(this));
    this.game.on('packet:receive:SMSG_MOVE_KNOCK_BACK', this.handleKnockBack.bind(this));

    setMovementSink(this);
  }

  // ---------------------------------------------------------------------------------------- inbound

  /**
   * A peer's movement. One decode for the whole family, because what we do with it -- put the body
   * at the stated place, smoothly -- does not depend on which key he pressed.
   */
  private handleRelay(packet: GamePacket) {
    const info = readMovementInfo(packet);
    this.received.relays += 1;

    const unit = this.game.world.entities.get(info.guid);
    if (!unit) {
      // Not an error: the server relays movement for units whose create block has not arrived yet,
      // or which we dropped. The position is simply not ours to draw.
      return;
    }
    if (unit === this.game.world.player) {
      // The server echoing OUR movement back at us. Applying it would fight the local mover every
      // frame it disagreed. Ignored on purpose -- a real correction arrives as MSG_MOVE_TELEPORT.
      return;
    }

    unit.applyRemoteState({ x: info.x, y: info.y, z: info.z }, info.facing, info.flags);
  }

  private speeds: Partial<Record<string, number>> = {};

  /**
   * `MSG_MOVE_SET_*_SPEED`: a `MovementInfo` followed by ONE float. The run speed is the one this
   * client acts on -- it is `moveSpeed`, which the gait selector reads.
   */
  private handleSpeed(packet: GamePacket, key: keyof SpeedSet) {
    const info = readMovementInfo(packet);
    const speed = packet.readFloat();
    this.received.speeds += 1;

    const unit = this.game.world.entities.get(info.guid);
    if (!unit) {
      return;
    }
    // The position is applied only to a unit that is NOT mid-spline. `applyRemoteState` clears the
    // ride by design -- the two must never both own the body -- and a speed message is not a
    // statement that the walk is over. `MSG_MOVE_SET_*_SPEED` is the player form (the creature form
    // is `SMSG_SPLINE_SET_*_SPEED`), but five of them landed in the recorded entry burst and a
    // mis-addressed one would have stopped a creature dead in the middle of its patrol.
    if (unit !== this.game.world.player && !unit.splineRide) {
      unit.applyRemoteState({ x: info.x, y: info.y, z: info.z }, info.facing, info.flags);
    }
    if (key === 'run') {
      unit.moveSpeed = speed;
    }
  }

  /**
   * `SMSG_FORCE_*_SPEED_CHANGE` / `SMSG_FORCE_MOVE_(UN)ROOT`: a packed guid, a change COUNTER and
   * (for the speed forms) a float. The ack echoes the guid and the counter, and the server drops
   * any ack whose counter it did not issue -- which is why the counter is read and echoed rather
   * than zeroed.
   */
  private handleForce(packet: GamePacket, ackOpcode: number) {
    const guid = packet.readPackedGUID();
    const counter = packet.readUnsignedInt();
    // The root forms carry no payload past the counter; the speed forms carry one float. `available`
    // is the only honest test -- the opcode table alone would have to be trusted.
    const speed = packet.available >= 4 ? packet.readFloat() : null;
    this.received.acks += 1;

    // Exactly sized, for the reason `movementInfoSize` gives: an over-allocated `GamePacket` sends
    // its slack as declared payload.
    const ack = new GamePacket(
      ackOpcode,
      GamePacket.HEADER_SIZE_OUTGOING + packedGuidSize(guid) + 4 + (speed !== null ? 4 : 0),
    );
    ack.writePackedGUID(guid);
    ack.writeUnsignedInt(counter);
    if (speed !== null) {
      ack.writeFloat(speed);
    }
    this.game.send(ack);

    const unit = this.game.world.entities.get(guid);
    if (unit && speed !== null && ackOpcode === GameOpcode.CMSG_FORCE_RUN_SPEED_CHANGE_ACK) {
      unit.moveSpeed = speed;
    }
  }

  /**
   * `MSG_MOVE_TELEPORT_ACK`: the server has relocated us and is waiting to be told we noticed. The
   * ack is what it is waiting for; MOVING the local body to the destination is NOT done here -- see
   * the class docs.
   */
  private handleTeleport(packet: GamePacket) {
    const guid = packet.readPackedGUID();
    const counter = packet.readUnsignedInt();
    const info = readMovementInfo(packet, false);

    const ack = new GamePacket(
      GameOpcode.MSG_MOVE_TELEPORT_ACK,
      GamePacket.HEADER_SIZE_OUTGOING + packedGuidSize(guid) + 4 + 4,
    );
    ack.writePackedGUID(guid);
    ack.writeUnsignedInt(counter);
    ack.writeUnsignedInt(info.timeStamp);
    this.game.send(ack);

    console.warn(
      'movement: MSG_MOVE_TELEPORT_ACK acked but NOT APPLIED -- the server has moved'
      + ` ${guid} to (${info.x.toFixed(1)}, ${info.y.toFixed(1)}, ${info.z.toFixed(1)}) and this`
      + ' client is still standing where it was. Relocating the local mover needs the map-change'
      + ' and settle-hold path, which is out of this task.',
    );
  }

  private handleKnockBack() {
    console.warn(
      'movement: SMSG_MOVE_KNOCK_BACK received and NOT APPLIED -- no knockback arc in this client.',
    );
    this.received.unhandled += 1;
  }

  // --------------------------------------------------------------------------------------- outbound

  /**
   * One frame of our own movement, from `game/movement/outbound.ts`. Sends at most one packet per
   * frame: an edge if there is one, else a heartbeat if one is due, else nothing.
   */
  streamMovement(state: PlayerMoveState, flags: number, nowSeconds: number) {
    const player = this.game.world && this.game.world.player;
    // A guid that does not resolve to a real 64-bit value is rejected, not just a missing one.
    // `Session#player` is constructed as `new Player('Player', '-1')` and keeps the literal string
    // `'Player'` as its guid until `GameHandler#join` overwrites it with the roster's. `'Player'` is
    // truthy and `guidBytes` answers eight zeros for it, so a plain `!player.guid` guard let the
    // first frames of world entry stream out under guid ZERO -- MEASURED on a live entry: a
    // `MSG_MOVE_JUMP` of Length 53 / Body 47, which is 47 = 1 + 4 + 2 + 4 + 16 + 4 + 16, i.e. a
    // one-byte packed guid: the mask, and no bytes at all. The server drops any movement whose guid
    // is not the mover's, so those were wasted; `packedGuidSize === 1` is exactly "all bytes zero".
    if (!player || !player.guid || packedGuidSize(player.guid) === 1) {
      return;
    }

    const nowMs = performance.now();
    const changed = flags ^ this.sentFlags;

    if (changed !== 0) {
      const opcode = this.opcodeForEdge(flags, changed);
      if (opcode !== null) {
        this.send(opcode, state, flags, nowSeconds);
        this.sentFlags = flags;
        this.lastHeartbeatMs = nowMs;
        this.lastSentFacing = state.faceYaw;
        return;
      }
      // A flag changed that has no opcode of its own (FALLING_FAR latching, say). Fold it into the
      // next heartbeat rather than inventing a packet for it.
      this.sentFlags = flags;
    }

    if (flags !== 0 && nowMs - this.lastHeartbeatMs >= HEARTBEAT_MS) {
      this.send(GameOpcode.MSG_MOVE_HEARTBEAT, state, flags, nowSeconds);
      this.sent.heartbeats += 1;
      this.lastHeartbeatMs = nowMs;
      this.lastSentFacing = state.faceYaw;
      return;
    }

    // Standing still and turning on the spot: the position has not changed but the FACING has, and
    // a server that never hears about it draws us facing the wrong way to everyone else.
    if (flags === 0 && Math.abs(wrapPi(state.faceYaw - this.lastSentFacing)) > FACING_EPSILON) {
      this.send(GameOpcode.MSG_MOVE_SET_FACING, state, flags, nowSeconds);
      this.sent.facings += 1;
      this.lastSentFacing = state.faceYaw;
      this.lastHeartbeatMs = nowMs;
    }
  }

  /**
   * Which opcode announces this edge. Order matters: the reference client announces the START of a
   * newly-set flag before the STOP of a cleared one, and a jump before either.
   */
  private opcodeForEdge(flags: number, changed: number): number | null {
    if ((changed & MovementFlag.FALLING) !== 0) {
      if ((flags & MovementFlag.FALLING) !== 0) {
        this.sent.jumps += 1;
        return GameOpcode.MSG_MOVE_JUMP;
      }
      this.sent.lands += 1;
      return GameOpcode.MSG_MOVE_FALL_LAND;
    }
    if ((changed & MovementFlag.SWIMMING) !== 0) {
      return (flags & MovementFlag.SWIMMING) !== 0
        ? GameOpcode.MSG_MOVE_START_SWIM
        : GameOpcode.MSG_MOVE_STOP_SWIM;
    }

    const started = START_OPCODES.find(([bit]) => (changed & bit) !== 0 && (flags & bit) !== 0);
    if (started) {
      this.sent.starts += 1;
      return started[1];
    }

    if ((changed & TRANSLATE_MASK) !== 0 && (flags & TRANSLATE_MASK) === 0) {
      this.sent.stops += 1;
      return GameOpcode.MSG_MOVE_STOP;
    }
    if ((changed & STRAFE_MASK) !== 0 && (flags & STRAFE_MASK) === 0) {
      this.sent.stops += 1;
      return GameOpcode.MSG_MOVE_STOP_STRAFE;
    }
    if ((changed & TURN_MASK) !== 0 && (flags & TURN_MASK) === 0) {
      this.sent.stops += 1;
      return GameOpcode.MSG_MOVE_STOP_TURN;
    }
    return null;
  }

  private send(opcode: number, state: PlayerMoveState, flags: number, nowSeconds: number) {
    const player = this.game.world.player;
    // EXACTLY sized: see `movementInfoSize`. A `GamePacket` allocated with slack sends the slack,
    // declared as payload, because `GameHandler#send` measures the ALLOCATED length.
    const packet = new GamePacket(
      opcode,
      GamePacket.HEADER_SIZE_OUTGOING + movementInfoSize(player.guid, flags, 0),
    );

    // The wire's `fallTime` is milliseconds since this airborne phase began. `airborneSince` is
    // stamped in the same elapsed-SECONDS clock `nowSeconds` comes from, which is the only reason
    // this subtraction is meaningful -- see `MovementSink`.
    const fallTime = state.airborneSince !== null
      ? Math.max(0, Math.round((nowSeconds - state.airborneSince) * 1000))
      : 0;

    writeMovementInfo(packet, {
      guid: player.guid,
      flags,
      flags2: 0,
      // `GetMSTime()`: a client-relative millisecond tick, not a wall clock. The server only ever
      // differences consecutive values of it.
      timeStamp: Math.round(performance.now()) >>> 0,
      x: state.pos.x,
      y: state.pos.y,
      z: state.pos.z,
      facing: state.faceYaw,
      pitch: state.swimPitch,
      fallTime,
      // The jump block, present exactly when MOVEMENTFLAG_FALLING is: vertical speed, then the
      // sin/cos of the take-off heading, then the horizontal speed.
      fallVelocity: state.velZ,
      fallSinAngle: Math.sin(state.faceYaw),
      fallCosAngle: Math.cos(state.faceYaw),
      fallSpeed: Math.hypot(state.horizVel.x, state.horizVel.y),
    });

    this.game.send(packet);
    this.sent.total += 1;
  }
}

/** Shortest signed angle. Local copy: this file must not depend on the camera rig. */
function wrapPi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
