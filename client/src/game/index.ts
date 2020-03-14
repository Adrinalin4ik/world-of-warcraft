import World from './world'
import Network from './network';

export default class Game {
  public world: World;
  public network: Network
  constructor() {
    this.world = new World();
    this.network = new Network(this.world);
  }
}