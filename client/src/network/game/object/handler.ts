import EventEmitter from 'events';
import { GameHandler } from '../handler';
import { UpdateObjectHandler } from './update-object/handler';

export class ObjectHandler extends EventEmitter {
  private game: GameHandler;
  private updateObjectHandler: UpdateObjectHandler;
  // Creates a new character handler
  constructor(gameHandler: GameHandler) {
    super();

    // Holds session
    this.game = gameHandler;
    this.updateObjectHandler = new UpdateObjectHandler(this.game);
  }
}
