import Player from "../../classes/player";

export interface IPeerArgs {
  id: string;
  player: Player;
}

export default class Peer {
  public id: string;
  public player: Player
  constructor(args: IPeerArgs) {
    this.id = args.id;
    this.player = args.player;
  }
}