import World from './world'

export default class Game {
  public world: World;
  constructor() {
    this.world = new World();
  }
}