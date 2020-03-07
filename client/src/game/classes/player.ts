import Unit from './unit';

class Player extends Unit {
  public mapId: number | null;

  constructor(guid: string, name: string) {
    super(guid);
    this.displayId = 22235;
    this.name = name;
    this.mapId = null;
    this.view.name = "MainPlayer";

    (window as any).player = this;
  }

  worldport(mapId: number, coord: Array<number>) {
    this.changePosition({x: coord[0], y: coord[1], z: coord[2]});
    if (!this.mapId || this.mapId !== mapId) {
      this.mapId = mapId;
      this.emit('map:change', mapId);
    }
    this.emit('position:change', this.position);
  }

}

export default Player;
