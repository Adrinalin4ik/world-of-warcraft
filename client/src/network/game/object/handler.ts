import EventEmitter from 'events';
import { GameHandler } from '../handler';
import { MonsterMovementtHandler } from './monster-movement/handler';
import { PlayerMovementHandler } from './player/movement';
import { UpdateObjectHandler } from './update-object/handler';

export class ObjectHandler extends EventEmitter {
  private game: GameHandler;
  public updateObjectHandler: UpdateObjectHandler;

  // PUBLIC so the movement instruments can read their counters. `MonsterMovementtHandler#stats` and
  // `PlayerMovementHandler#sent` are how a probe distinguishes "the world is still" from "the world
  // is moving and we are not drawing it", which was the whole ambiguity before this task.
  public monsterMovementHandler: MonsterMovementtHandler;

  public playerMovementHandler: PlayerMovementHandler;
  // Creates a new character handler
  constructor(gameHandler: GameHandler) {
    super();

    // Holds session
    this.game = gameHandler;
    this.updateObjectHandler = new UpdateObjectHandler(this.game);
    this.monsterMovementHandler = new MonsterMovementtHandler(this.game);
    this.playerMovementHandler = new PlayerMovementHandler(this.game);
  }
}
