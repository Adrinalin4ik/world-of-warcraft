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

  worldport(mapId: number, coords: Array<number>) {
    this.changePosition({ x: coords[0], y: coords[1], z: coords[2] });
    if (!this.mapId || this.mapId !== mapId) {
      this.mapId = mapId;
      this.emit('map:change', mapId);
      localStorage.setItem('lastLocation', JSON.stringify({
        zoneId: mapId,
        coords
      }));
    }
    this.emit('position:change', this.position, this.view.rotation);
  }

}

export default Player;
