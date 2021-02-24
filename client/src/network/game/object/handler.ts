import EventEmitter from 'events';
import { GameHandler } from '../handler';
import { MonsterMovementtHandler } from './monster-movement/handler';
import { PlayerMovementHandler } from './player/movement';
import { UpdateObjectHandler } from './update-object/handler';

export class ObjectHandler extends EventEmitter {
  private game: GameHandler;
  private updateObjectHandler: UpdateObjectHandler;
  private monsterMovementHandler: MonsterMovementtHandler;
  private playerMovementHandler: PlayerMovementHandler;
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
