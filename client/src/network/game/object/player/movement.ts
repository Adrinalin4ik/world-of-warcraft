import EventEmitter from 'events';
import * as THREE from 'three';
import { setMovementSink } from '../../../../game/movement/outbound';
import { clientTicks } from '../../time-sync';
import { PlayerMoveState } from '../../../../game/movement/player-state';
import { GameHandler } from '../../handler';
import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import {
  MovementFlag, MovementInfo, movementInfoSize, packedGuidSize, readMovementInfo, wireFacing,
  writeMovementInfo,
} from '../../movement-info';
import { MoveSpeeds } from '../../../../game/movement/net-motion';

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

/**
 * The outbound wire recorder -- the instrument that made this file's defects visible.
 *
 * Off by default and allocating nothing while off, exactly like `game/movement/move-trace.ts`. Turn
 * it on with `window.moveWire.enabled = true` and read `window.moveWire.history()`; each row is one
 * packet AS SENT, so what it shows is what an observing client has to extrapolate from.
 *
 * It exists because the only symptom available for this class of defect is somebody else's screen.
 * The owner watched this character from the real 3.3.5a client and reported a jerk every 250-500 ms;
 * nothing on our own screen shows that, because our own body is drawn from the local mover and never
 * from the wire. The recorder is what turned "it looks jerky over there" into the capture in
 * `task-9-report.md`: walking forward for 14.4 s while turning the mouse 154 degrees put THIRTY
 * packets on the wire at a p50 of 509.9 ms apart, and not one of them was a `MSG_MOVE_SET_FACING`.
 */
export interface MoveWireRow {
  /** `performance.now()` at the send, ms. Differencing consecutive rows gives the real cadence. */
  at: number;
  opcode: string;
  flags: number;
  flags2: number;
  /** The `MovementInfo.time` field actually written, in the client's own tick base. */
  timeStamp: number;
  x: number;
  y: number;
  z: number;
  facing: number;
  fallTime: number;
  /** Bytes of body, i.e. what `movementInfoSize` computed. */
  bodyBytes: number;
}

class MoveWireTrace {
  enabled = false;

  private rows: MoveWireRow[] = [];

  private limit = 4000;

  record(row: MoveWireRow): void {
    if (!this.enabled) {
      return;
    }
    this.rows.push(row);
    if (this.rows.length > this.limit) {
      this.rows.shift();
    }
  }

  history(): readonly MoveWireRow[] {
    return this.rows;
  }

  clear(): void {
    this.rows.length = 0;
  }
}

export const moveWire = new MoveWireTrace();

if (typeof window !== 'undefined') {
  (window as any).moveWire = moveWire;
}

/** Opcode number -> name, for the recorder only. Built once, lazily. */
let opcodeNames: Map<number, string> | null = null;
function opcodeName(opcode: number): string {
  if (opcodeNames === null) {
    opcodeNames = new Map();
    Object.getOwnPropertyNames(GameOpcode).forEach((key) => {
      const value = (GameOpcode as any)[key];
      if (typeof value === 'number' && !opcodeNames!.has(value)) {
        opcodeNames!.set(value, key);
      }
    });
  }
  return opcodeNames.get(opcode) ?? `0x${opcode.toString(16)}`;
}

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

/**
 * The bits that mean the body is genuinely in motion, so its position is EXPECTED to change every
 * frame and the at-rest reconcile must stay quiet. The reference's `IN_MOTION`
 * (`movement_net.rs:78-88`). Turning in place is deliberately absent -- a keyboard turn moves
 * nothing, so a drift under it is still news.
 */
const IN_MOTION = TRANSLATE_MASK | STRAFE_MASK
  | MovementFlag.FALLING | MovementFlag.FALLING_FAR
  | MovementFlag.SWIMMING | MovementFlag.ASCENDING | MovementFlag.DESCENDING
  | MovementFlag.ONTRANSPORT;

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
 * The parts of a relayed `MovementInfo` past the pose that a peer's dead reckoning needs.
 *
 * `readMovementInfo` has decoded all of this since it was written and NOTHING PASSED IT ON: every
 * relay reached `Unit#applyRemoteState` as position + facing + flags alone. The consequences were
 * both visible and both the owner's report:
 *
 *  - the jump tail never arrived, so `applyRemoteMove`'s ballistic seed -- the branch that gives an
 *    airborne peer his arc -- was UNREACHABLE in production. An observed jump had zero vertical AND
 *    zero horizontal velocity between packets: the peer hung motionless in the air and was then
 *    teleported along the arc by each heartbeat, which is "прыжок начинается с середины";
 *  - the swim pitch never arrived, so a diving swimmer slid flat between packets.
 *
 * `fallTime` matters even without a jump block: it is how far into the arc the seed is
 * (`-zspeed - g*t`), so a peer first seen mid-jump starts from the right vertical speed instead of
 * from his take-off one.
 */
function remoteTail(info: MovementInfo) {
  return {
    pitch: info.pitch,
    fallTime: info.fallTime,
    jump: (info.flags & MovementFlag.FALLING) !== 0
      ? {
        zSpeed: info.fallVelocity,
        sinAngle: info.fallSinAngle,
        cosAngle: info.fallCosAngle,
        xySpeed: info.fallSpeed,
      }
      : null,
  };
}

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

/**
 * Relay key -> the `MoveSpeeds` member it belongs in. `flight`, `flightBack` and `pitch` are absent on
 * purpose: `MoveSpeeds` has no member for them and no consumer, so there is nowhere honest to put them.
 */
const SPEED_FIELD: Partial<Record<keyof SpeedSet, keyof MoveSpeeds>> = {
  walk: 'walk',
  run: 'run',
  runBack: 'runBack',
  swim: 'swim',
  swimBack: 'swimBack',
  turn: 'turnRate',
};

/** The same mapping for the FORCE forms, keyed by the ack opcode this handler already switches on. */
const FORCE_FIELD: Partial<Record<number, keyof MoveSpeeds>> = {
  [GameOpcode.CMSG_FORCE_WALK_SPEED_CHANGE_ACK]: 'walk',
  [GameOpcode.CMSG_FORCE_RUN_SPEED_CHANGE_ACK]: 'run',
  [GameOpcode.CMSG_FORCE_RUN_BACK_SPEED_CHANGE_ACK]: 'runBack',
  [GameOpcode.CMSG_FORCE_SWIM_SPEED_CHANGE_ACK]: 'swim',
  [GameOpcode.CMSG_FORCE_SWIM_BACK_SPEED_CHANGE_ACK]: 'swimBack',
  [GameOpcode.CMSG_FORCE_TURN_RATE_CHANGE_ACK]: 'turnRate',
};

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

  /** The facing as it went on the wire (normalised), i.e. what the previous frame's facing was. */
  private lastSentFacing = 0;

  private lastHeartbeatMs = 0;

  /**
   * The position the server was last told. Not `state.pos` itself -- that object is mutated in
   * place by the mover every frame, so holding a reference would make every comparison trivially
   * equal. `Vector3#equals` is the exact float compare the server's own `positionChanged` test uses.
   */
  private lastSentPos = new THREE.Vector3(NaN, NaN, NaN);

  /** Counters the world-state probe reads to prove the outbound stream is real. */
  public sent = {
    total: 0, heartbeats: 0, starts: 0, stops: 0, facings: 0, jumps: 0, lands: 0,
    /**
     * `CMSG_MOVE_SPLINE_DONE` acks emitted -- the instrument for the self-spline ride. Should
     * equal `objectHandler.monsterMovementHandler.stats.selfMoves` plus the self `Stop`s once every
     * ride has finished; a gap means a ride never reached its end and the server is still holding
     * our mover, which is the state in which it drops every movement packet we send.
     */
    splineDones: 0,
  };

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

    unit.applyRemoteState(
      { x: info.x, y: info.y, z: info.z }, info.facing, info.flags, remoteTail(info),
    );
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
      unit.applyRemoteState(
        { x: info.x, y: info.y, z: info.z }, info.facing, info.flags, remoteTail(info),
      );
    }
    // EVERY rate the unit can hold, not just `run`. See `Unit#setWireSpeed` for what dropping the
    // other eight cost. `SPEED_FIELD` maps the relay key onto the field; a key with no home (flight,
    // flightBack, pitch -- `MoveSpeeds` has no member for them and nothing reads one) is skipped
    // rather than invented.
    const field = SPEED_FIELD[key];
    if (field) {
      unit.setWireSpeed(field, speed);
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
    if (unit && speed !== null) {
      // Same completion as the relay path above: the run arm was the only one, so a forced walk, swim,
      // backpedal or turn rate was acked and then discarded.
      const field = FORCE_FIELD[ackOpcode];
      if (field) {
        unit.setWireSpeed(field, speed);
      }
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

  /**
   * `SMSG_MOVE_KNOCK_BACK` -- STILL A NAMED GAP, and the self-spline ride does not close it.
   *
   * The two are different mechanisms and only one of them arrived this round. A spline knockback
   * (the server pathing our mover) now works, because it comes down as an `SMSG_MONSTER_MOVE` for
   * our guid like any other ride. THIS packet is the other kind: an IMPULSE, not a path -- the
   * server hands the client a launch vector and the client integrates the arc itself, then acks on
   * `CMSG_MOVE_KNOCK_BACK_ACK` (`opcode.js:242`, present in the table and never sent).
   *
   * **WHAT IT CARRIES IS NOT ESTABLISHED HERE and must not be guessed.** The reference does not
   * decode this packet either -- `benilla-protocol` has the opcode in its NAME table only
   * (`messages/opcode_names.rs:265-267`) and no reader for it -- and no capture of one has been
   * through a residual on this project. So the body layout, the vertical field's sign convention
   * and the ack's shape are all unread, and every one of them is a width trap of the class
   * `CLAUDE.md` records as this project's most repeated silent defect. Closing this gap starts
   * with a capture, not with a struct.
   *
   * Until then: nothing is decoded, no arc is seeded, no ack is sent, and the server is left
   * waiting on an acknowledgement it will never receive.
   */
  private handleKnockBack() {
    console.warn(
      'movement: SMSG_MOVE_KNOCK_BACK received and NOT APPLIED -- this is the IMPULSE form of a'
      + ' knockback (a launch vector the client integrates itself, then acks on'
      + ' CMSG_MOVE_KNOCK_BACK_ACK) and NOTHING in this client decodes its body. The SPLINE form'
      + ' -- a server-pathed displacement such as Charge -- IS followed; see'
      + ' game/movement/server-ride.ts.',
    );
    this.received.unhandled += 1;
  }

  // --------------------------------------------------------------------------------------- outbound

  /**
   * One frame of our own movement, from `game/movement/outbound.ts`.
   *
   * THE SEND LAW, and why it is not "one packet per frame".
   *
   * The reference (`samples/benilla/crates/benilla/src/player/movement_net.rs#stream_self_movement`)
   * models this as THREE INDEPENDENT EMITTERS that can all fire on the same frame, not one
   * prioritised channel:
   *
   *  1. the move-state broadcaster -- one `MSG_MOVE_*` per movement-AXIS transition;
   *  2. the facing report -- one `MSG_MOVE_SET_FACING` on every frame the facing changed, whether or
   *     not we are moving, excluded only while a TURN flag is set;
   *  3. the ~500 ms heartbeat, and the at-rest position reconcile.
   *
   * This client had only (1) and a crippled (3), and (2) was gated on `flags === 0` -- so it sent a
   * facing update only while STANDING STILL. That is the defect the owner saw from the real client:
   * walking forward while turning with the mouse (which is how anyone actually turns; A/D is the
   * only input that raises a TURN flag here, see `Controls#update` step 3 vs `look.turnsCharacter`)
   * put NO orientation on the wire for up to 500 ms. An observer dead-reckons a moving unit along
   * the orientation it was last told, so it walked our character in the stale direction for half a
   * second and then snapped him to the heartbeat's position. Once every heartbeat. Exactly the
   * reported 250-500 ms jerk.
   *
   * The reference's evidence for (2) being frame-cadence rather than an epsilon-gated afterthought
   * is a real 1.12.1 sniff, quoted at `movement_net.rs:314-330`: 179 of 336 client-sent movement
   * packets are `SET_FACING` -- more than every other movement opcode combined -- at a median 41 ms
   * apart, and 116 of the 179 carry a direction bit (`Forward` x68, `Backward` x12,
   * `Forward+StrafeRight` x9, ...). There is no rate limit and no angular epsilon: the change
   * detector is an EXACT comparison, so a frame that did not move the mouse sends nothing. The old
   * `FACING_EPSILON = 0.01` here is therefore gone; `faceYaw` is only ever written by real input, so
   * the exact test neither floods nor misses.
   *
   * `MSG_MOVE_SET_FACING` is NOT gated on whether a transition already went out this frame -- the
   * same sniff repeatedly shows the two sharing a millisecond.
   *
   * Raising the heartbeat rate was considered and rejected: the reference's 500 ms is
   * binary-verified (`movement_net.rs:38-41`, the local-player send deadline at `mgr+0x130` armed to
   * `clientTime + 500 ms`, `0x615b80`), the real client is smooth to observers at it, and a higher
   * rate would only paper over the missing facing.
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
    const facing = wireFacing(state.faceYaw);
    const changed = flags ^ this.sentFlags;
    let sent = false;

    // (1) The move-state broadcaster: one packet per movement-axis transition.
    if (changed !== 0) {
      const opcode = this.opcodeForEdge(flags, changed);
      if (opcode !== null) {
        this.send(opcode, state, flags, facing, nowSeconds);
        sent = true;
      }
      // A flag with no opcode of its own (FALLING_FAR latching, say) just rides the next packet.
      this.sentFlags = flags;
    }

    // (2) The facing report -- see the send law above. Independent of (1), and of whether we are
    // moving. Excluded only on the TURN axis: a keyboard turn is fully described by its flag, since
    // observers rotate the mover at its turn rate for as long as the flag is set, and the STOP_TURN
    // carries the final angle. (Not one SET_FACING in the reference's sniff carries a turn bit.)
    if ((flags & TURN_MASK) === 0 && facing !== this.lastSentFacing) {
      this.send(GameOpcode.MSG_MOVE_SET_FACING, state, flags, facing, nowSeconds);
      this.sent.facings += 1;
      sent = true;
    }

    // (3a) The heartbeat, when nothing else went out. NOT while FALLING: the JUMP packet seeded the
    // whole ballistic arc and an observer integrates it locally, so the real client sends no mid-air
    // packet at all -- each extra one is a smoothing-free snap-apply over there
    // (`movement_net.rs:341-353`, sniff-verified).
    const falling = (flags & MovementFlag.FALLING) !== 0;
    if (!sent && flags !== 0 && !falling && nowMs - this.lastHeartbeatMs >= HEARTBEAT_MS) {
      this.send(GameOpcode.MSG_MOVE_HEARTBEAT, state, flags, facing, nowSeconds);
      this.sent.heartbeats += 1;
      sent = true;
    }

    // (3b) The at-rest position reconcile (`movement_net.rs:356-380`, the reference's decision 0907).
    // The server's copy of where we are may never go stale. Our own resolver settles a body that is
    // already at rest by a fraction of a millimetre AFTER the packet that reported the rest -- a
    // landing reports the touchdown pose and the next frame's snap takes a little off it; a login
    // lands on a server-authored position our collision resolves a hair differently. While standing
    // still nothing else goes out, so the delta accumulates and the next packet of any kind delivers
    // it all at once, which the server reads as movement on an EXACT float compare and which cancels
    // a cast. Reporting it when it happens -- at rest, so once per settle rather than per frame --
    // keeps the two copies identical.
    if (!sent && (flags & IN_MOTION) === 0 && !this.lastSentPos.equals(state.pos)) {
      this.send(GameOpcode.MSG_MOVE_HEARTBEAT, state, flags, facing, nowSeconds);
      this.sent.heartbeats += 1;
      sent = true;
    }

    if (sent) {
      this.lastHeartbeatMs = nowMs;
    }
    // The change detector's reference is the PREVIOUS FRAME's facing, not the last one reported: a
    // turn-axis frame deliberately sends nothing, and must not leave a catch-up SET_FACING behind
    // for the frame the key releases.
    this.lastSentFacing = facing;
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

  /**
   * **`CMSG_MOVE_SPLINE_DONE`: the acknowledgement a finished self-spline owes.**
   *
   * The server moved OUR mover with a spline (Charge, a knockback path, a taxi flight, a fear) and
   * for a player mover it waits on this before it stops treating us as spline-controlled -- and
   * while it waits it DROPS EVERY MOVEMENT PACKET WE SEND. So an unridden or unacked spline is not
   * a cosmetic gap: it silently kills the outbound stream for the rest of the session. See
   * `game/movement/server-ride.ts` for the ride this closes.
   *
   * THE BODY, and the one deliberate choice in it. The leading bytes are a `MovementInfo` -- for
   * this client's 3.3.5a shape that INCLUDES the packed guid and the `flags2` half-word
   * (`movementInfoSize`), which the reference's 1.12 writer has neither of; taking its struct
   * verbatim is exactly the trap `CLAUDE.md` describes, so only the ORDER is taken from it. Then
   * the `u32 splineId`. Then a trailing `float`:
   *
   *   - the reference writes one and says why (`benilla-protocol/src/messages/client.rs:286-302`,
   *     byte-verified golden at `:373-403`): vmangos's `MoveSplineDone::ReadFromWorldPacket` does
   *     an unconditional `read_skip<float>()`, the real client puts its completion fraction
   *     `clamp(elapsed/duration, 0, 1)` there, and we only ever send at completion, so 1.0;
   *   - THIS BUILD'S handler has not been read, so whether 3.3.5a still reads that fourth word is
   *     UNVERIFIED. `CLAUDE.md`'s rule settles it without a capture: a server `ByteBuffer` throws
   *     only on an UNDER-read and silently ignores trailing bytes it never reads, so including the
   *     float is required if the word exists and harmless if it does not, while omitting it is
   *     fatal in the first case -- and the failure mode of a short body is total silence, no
   *     `SMSG_*_FAILURE` and a mover the server never releases. So: prefer the longer body.
   *
   * `flags` is 0 and `fallTime` is 0 -- the ride ended AT REST at the endpoint, which is also what
   * `serverRideFrame` has just written into the mover state (`server-ride.ts#resumeAtRest`). The
   * reference sends the same (`server_ride.rs:156-161`, `flags: 0`).
   */
  sendSplineDone(state: PlayerMoveState, splineId: number) {
    const player = this.game.world && this.game.world.player;
    // The same guid gate `streamMovement` applies, and for the same reason: before `join` rewrites
    // it, `Session#player`'s guid is the literal string `'Player'`, which is truthy and packs to
    // eight zero bytes. A body carrying a zero guid is dropped by the server, so the ack would
    // vanish and the mover would stay held.
    if (!player || !player.guid || packedGuidSize(player.guid) === 1) {
      return;
    }

    const bodyBytes = movementInfoSize(player.guid, 0, 0) + 4 + 4;
    // EXACTLY sized: `GameHandler#send` measures the ALLOCATED length, so slack goes out as
    // declared payload.
    const packet = new GamePacket(
      GameOpcode.CMSG_MOVE_SPLINE_DONE,
      GamePacket.HEADER_SIZE_OUTGOING + bodyBytes,
    );
    const facing = wireFacing(state.faceYaw);
    const timeStamp = clientTicks();
    writeMovementInfo(packet, {
      guid: player.guid,
      flags: 0,
      flags2: 0,
      timeStamp,
      x: state.pos.x,
      y: state.pos.y,
      z: state.pos.z,
      facing,
      pitch: 0,
      fallTime: 0,
    });
    packet.writeUnsignedInt(splineId >>> 0);
    // The completion fraction. We only ever send at completion, so 1.0 -- see the header.
    packet.writeFloat(1);
    this.game.send(packet);

    this.sent.total += 1;
    this.sent.splineDones += 1;
    // The server relocates us to this pose on receipt, so it IS the last position it has for us.
    // Leaving the reconcile's baseline stale would make the next at-rest frame report a delta the
    // server already has -- a heartbeat the server reads as movement, which cancels a cast.
    this.lastSentPos.set(state.pos.x, state.pos.y, state.pos.z);
    this.lastSentFacing = facing;
    this.sentFlags = 0;

    moveWire.record({
      at: performance.now(),
      opcode: opcodeName(GameOpcode.CMSG_MOVE_SPLINE_DONE),
      flags: 0,
      flags2: 0,
      timeStamp,
      x: state.pos.x,
      y: state.pos.y,
      z: state.pos.z,
      facing,
      fallTime: 0,
      bodyBytes,
    });
  }

  private send(
    opcode: number,
    state: PlayerMoveState,
    flags: number,
    facing: number,
    nowSeconds: number,
  ) {
    const player = this.game.world.player;
    const bodyBytes = movementInfoSize(player.guid, flags, 0);
    // EXACTLY sized: see `movementInfoSize`. A `GamePacket` allocated with slack sends the slack,
    // declared as payload, because `GameHandler#send` measures the ALLOCATED length.
    const packet = new GamePacket(opcode, GamePacket.HEADER_SIZE_OUTGOING + bodyBytes);

    // The wire's `fallTime` is milliseconds since this airborne phase began. `airborneSince` is
    // stamped in the same elapsed-SECONDS clock `nowSeconds` comes from, which is the only reason
    // this subtraction is meaningful -- see `MovementSink`.
    const fallTime = state.airborneSince !== null
      ? Math.max(0, Math.round((nowSeconds - state.airborneSince) * 1000))
      : 0;

    // `GetMSTime()`: a client-relative millisecond tick, not a wall clock. It MUST be the same tick
    // base `CMSG_TIME_SYNC_RESP` reports, because the server subtracts the two to learn our clock
    // offset and then adds that offset to every `MovementInfo.time` we send. `clientTicks()` counts
    // from a module-load origin; this used to send raw `performance.now()`, so the two disagreed by
    // however many milliseconds elapsed between page load and that module's first import.
    const timeStamp = clientTicks();

    // The jump block's take-off HEADING, from the horizontal velocity the arc froze at launch rather
    // than from this frame's facing. They differ whenever the jump was taken strafing (the body's
    // heading is not its travel direction) or the mouse moved in mid-air, and it is the TRAVEL
    // direction the block describes: the reader reconstructs the frozen velocity as
    // `(cosAngle, sinAngle) * xySpeed` (`net-motion.ts#applyRemoteMove`, the reference's
    // `jump_seed`). A standstill jump has no direction, so it falls back to the facing.
    const jumpSpeed = Math.hypot(state.horizVel.x, state.horizVel.y);
    const jumpAngle = jumpSpeed > 1e-4
      ? Math.atan2(state.horizVel.y, state.horizVel.x)
      : facing;

    writeMovementInfo(packet, {
      guid: player.guid,
      flags,
      flags2: 0,
      timeStamp,
      x: state.pos.x,
      y: state.pos.y,
      z: state.pos.z,
      facing,
      pitch: state.swimPitch,
      fallTime,
      // The jump block, present exactly when MOVEMENTFLAG_FALLING is: vertical speed, then the
      // sin/cos of the take-off heading, then the horizontal speed.
      //
      // `zspeed` IS DOWN-POSITIVE AND IT IS THE LAUNCH SPEED, NOT THIS FRAME'S. Two corrections in
      // one field, and both were live defects:
      //
      //  - SIGN. The real client sends -7.955547 for a RISING jump (VERIFIED by a vanilla sniff,
      //    `samples/benilla/.../remote.rs:629-634`; vmangos likewise forces +7.958 UP from the wire's
      //    negative). We sent `+state.velZ`, i.e. the sign inverted, so any observer reconstructing
      //    the arc as `-zspeed` drove our jump straight into the ground.
      //  - CONSTANCY. The reader derives the CURRENT vertical speed as `-zspeed - g * fallTime`, so
      //    `zspeed` has to be the value the arc launched with and stay that way for the whole arc.
      //    Sending the live `velZ` double-counted gravity, since `fallTime` grows beside it.
      //
      // `state.jumpZSpeed` is exactly that launch snapshot: `JUMP_SPEED` for a jump and EXACTLY 0 for
      // a step off a ledge (`movement/mover.ts`), which is also how a reader tells the two apart.
      fallVelocity: -state.jumpZSpeed,
      fallSinAngle: Math.sin(jumpAngle),
      fallCosAngle: Math.cos(jumpAngle),
      fallSpeed: jumpSpeed,
    });

    this.game.send(packet);
    this.sent.total += 1;
    this.lastSentPos.set(state.pos.x, state.pos.y, state.pos.z);

    moveWire.record({
      at: performance.now(),
      opcode: opcodeName(opcode),
      flags,
      flags2: 0,
      timeStamp,
      x: state.pos.x,
      y: state.pos.y,
      z: state.pos.z,
      facing,
      fallTime,
      bodyBytes,
    });
  }
}

