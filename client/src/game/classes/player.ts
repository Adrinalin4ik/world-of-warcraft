import Unit from './unit';

class Player extends Unit {
  public mapId: number = 0;
  public x: number = 0;
  public y: number = 0;
  public z: number = 0;

  constructor(guid: string, name: string) {
    super(guid);
    this.displayId = 21976;
    this.name = name;
    this.view.name = "MainPlayer";
    this.isPlayer = true;
    (window as any).player = this;
  }

  worldport(mapId: number, coords: Array<number>) {
    console.log('worldport', coords)
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
