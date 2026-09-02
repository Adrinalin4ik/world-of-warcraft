import EventEmitter from 'events';
import { GameHandler } from '../../handler';
import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import { readMonsterMove } from './decode';

/**
 * `SMSG_MONSTER_MOVE` and `SMSG_MONSTER_MOVE_TRANSPORT` -- the creature half of movement, and by
 * volume almost all of it: 94 of the 309 packets in the recorded entry burst, and 642 in a 75 s
 * live capture at Northshire.
 *
 * THIS HANDLER WAS NEVER SUBSCRIBED. Both `game.on(...)` lines in its constructor were commented
 * out, so every one of those packets was decoded by nobody and every creature in the world stood
 * exactly where its create block put it. That is the whole of "the world does not move".
 *
 * The decode now lives in `./decode.ts`, established from those 642 real packets rather than from
 * documentation -- read its header before changing a byte of it.
 */
export class MonsterMovementtHandler extends EventEmitter {
  private game: GameHandler;

  /**
   * Counters the world-state probe reads. `dropped` is a decode that did not fit; see `decode.ts`.
   *
   * `selfMoves` is the OWNER'S REPORT "не работают способности, которые связаны с передвижением ...
   * например charge": a spline the server addressed to OUR OWN guid. It counted a SILENT NO-OP when
   * it was added; it now counts a ride the avatar actually follows -- see `handleMonsterMove` and
   * `game/movement/server-ride.ts`. `selfStops` is the other half: a `Stop` for our own guid, which
   * arms the same `CMSG_MOVE_SPLINE_DONE` wait as a path does.
   *
   * The pair is still the instrument. `selfMoves + selfStops` should equal
   * `playerMovementHandler.sent.splineDones` once every ride has finished; a shortfall means the
   * server is holding our mover spline-controlled, in which state it DROPS every movement packet
   * we send.
   */
  public stats = {
    moves: 0, stops: 0, dropped: 0, unknownUnits: 0, applied: 0, selfMoves: 0, selfStops: 0,
  };

  constructor(gameHandler: GameHandler) {
    super();
    this.game = gameHandler;
    this.game.on('packet:receive:SMSG_MONSTER_MOVE', this.handleMonsterMove.bind(this));
    this.game.on('packet:receive:SMSG_MONSTER_MOVE_TRANSPORT', this.handleMonsterMove.bind(this));
  }

  handleMonsterMove(packet: GamePacket) {
    const move = readMonsterMove(
      packet,
      packet.opcode === GameOpcode.SMSG_MONSTER_MOVE_TRANSPORT,
    );
    if (!move) {
      this.stats.dropped += 1;
      return;
    }
    this.stats.moves += 1;

    const unit = this.game.world.entities.get(move.guid);
    if (!unit) {
      // The server moves units whose create block has not arrived (or never will, because they are
      // outside our update range but inside someone else's). Nothing to draw.
      this.stats.unknownUnits += 1;
      return;
    }

    if (move.stop || move.path.length < 2) {
      // A `Stop` states a position and nothing else: the unit is standing there, now.
      this.stats.stops += 1;
      unit.clearSplinePath();

      // A STOP FOR OUR OWN GUID ARMS AN ACK, and the id it arms is THIS one.
      //
      // The server halts a spline-controlled mover by launching a fresh stop spline, and
      // `HandleMoveSplineDone` matches the acknowledgement against that NEWEST id -- so a ride cut
      // short and acked with the interrupted path's id is silently rejected and every movement
      // packet after it is dropped. The reference keeps the id rather than discarding it with the
      // path for exactly this reason (`net/motion/spline.rs:40-49`, decision 1281), and consumes
      // it in `player/server_ride.rs`'s stop arms.
      //
      // The position is NOT written onto the local mover here, deliberately, and the reference does
      // the same ("freeze where the last sample left it", `net/apply/objects.rs:549-556`): the ack
      // reports where the ride actually left us and the server relocates us to that pose on
      // receipt, so a snap here would only fight it. `unit.position` below is `view.position`,
      // which `syncViewFromMove` overwrites from `move.pos` on the next frame anyway -- for the
      // player it was never anything but a no-op.
      if (unit === this.game.world.player) {
        this.stats.selfStops += 1;
        unit.move.rideStopSplineId = move.splineId;
        return;
      }

      unit.position.set(move.start.x, move.start.y, move.start.z);
      if (move.facing.kind === 'angle') {
        unit.rotation.z = move.facing.angle as number;
      }
      return;
    }

    // A SPLINE ADDRESSED TO US IS A RIDE, and this is where the hand-off begins.
    //
    // It used to be a counted, warned no-op: the packet took the ordinary creature path below, set
    // `splineRide`, and was then ignored completely -- `Unit#update` returns immediately for
    // `isPlayer`, so `updateSplineFollowing` never ran on the player, and `Controls` re-copied
    // `move.pos` over `view.position` through `syncViewFromMove` on the very next frame. Even the
    // start snap was erased within one frame. That is the whole of "charge does nothing".
    //
    // The ride now belongs to the MOVER, not to the view: `Controls#update` calls
    // `serverRideFrame` (`game/movement/server-ride.ts`) before it reads any input, and while a
    // ride runs the spline is the sole authority over `move.pos` and the facing while input, the
    // capsule mover and the outbound movement stream all yield. Read that module's header for the
    // division of labour and for what happens to collision.
    //
    // TWO THINGS ARE WRITTEN HERE AND ONLY TWO. The path's first point is the server's idea of
    // where we are, so an out-of-position mover is corrected by starting the walk from it rather
    // than by a separate snap -- on `move.pos`, because `view.position` is not the player's
    // authority. And the ride itself, which the sampler then walks.
    if (unit === this.game.world.player) {
      this.stats.selfMoves += 1;
      // A real path supersedes any outstanding stop, exactly as the reference's
      // `.insert(spline).remove::<SplineStopped>()` does (`net/apply/objects.rs:546-548`): the
      // server is now waiting on THIS spline's id, and acking the older stop would be rejected.
      unit.move.rideStopSplineId = null;
      unit.move.pos.set(move.start.x, move.start.y, move.start.z);
      unit.setSplinePath(move.path, move.durationMs, move.flying, {
        id: move.splineId,
        finalFacing: move.facing.kind === 'angle' ? (move.facing.angle as number) : null,
      });
      if (unit.splineRide === null) {
        // `makeSplineRide` rejected it -- a zero duration, or a path whose whole length is under a
        // micrometre. There is no ride to walk, but the server is still holding our mover and
        // waiting to be told this spline finished, so the ack is owed from where we stand. Arming
        // the stop id is how `serverRideFrame` pays it (its `stopped` arm).
        unit.move.rideStopSplineId = move.splineId;
      }
      this.stats.applied += 1;
      return;
    }

    // The path's first point IS the server's idea of where the unit is right now, so an
    // out-of-position unit is corrected by starting the walk rather than by a separate snap.
    unit.position.set(move.start.x, move.start.y, move.start.z);
    unit.setSplinePath(move.path, move.durationMs, move.flying, {
      id: move.splineId,
      finalFacing: move.facing.kind === 'angle' ? (move.facing.angle as number) : null,
    });
    this.stats.applied += 1;
  }
}
