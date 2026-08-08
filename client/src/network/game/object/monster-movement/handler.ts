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

  /** Counters the world-state probe reads. `dropped` is a decode that did not fit; see `decode.ts`. */
  public stats = { moves: 0, stops: 0, dropped: 0, unknownUnits: 0, applied: 0 };

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
      unit.position.set(move.start.x, move.start.y, move.start.z);
      if (move.facing.kind === 'angle') {
        unit.rotation.z = move.facing.angle as number;
      }
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
