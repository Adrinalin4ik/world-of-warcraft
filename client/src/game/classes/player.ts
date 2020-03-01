import Unit from './unit';

class Player extends Unit {
  public mapId: number | null;

  constructor(name: string, guid: string) {
    super(guid);
    this.displayId = 24641;
    this.name = name;
    this.mapId = null;
    this.view.name = "MainPlayer";

    (window as any).player = this;
  }

  worldport(mapId: number, coord: Array<number>) {
    this.position.set(coord[0], coord[1], coord[2]);
    if (!this.mapId || this.mapId !== mapId) {
      this.mapId = mapId;
      this.emit('map:change', mapId);
    }
    this.emit('position:change', this.position);
  }

}

export default Player;
