import * as THREE from 'three';
import Player from '../classes/player';
import spots from './spots';
import Unit from '../classes/unit';

import M2Blueprint from '../pipeline/m2/blueprint';
import WorldMap from './map';
import { EventEmitter } from 'events';

export default class World extends EventEmitter {
  public scene: THREE.Scene;
  public debugScene: THREE.Scene;
  public player: Player;
  private entities: Set<Unit> = new Set();
  private map: WorldMap | null = null;

  constructor() {
    super();

    this.scene = new THREE.Scene();
    this.scene.matrixAutoUpdate = true;
    this.debugScene = new THREE.Scene();
    this.debugScene.matrixAutoUpdate = true;

    this.entities = new Set();

    this.player = new Player("TestName", "-1");
    this.add(this.player);
    this.player.on('map:change', this.changeMap.bind(this));
    this.player.on('position:change', this.changePosition.bind(this));

    // const spot: any = spots[spots.length - 2]
    const spot: any = spots.find(x => x.id === "dun murog")
    // const spot: any = spots.find(x => x.id === "stormwind")
    this.player.worldport(spot.zoneId, spot.coords);
  }

  add(entity: Unit) {
    this.entities.add(entity);
    if (entity.view) {
      this.scene.add(entity.view);
      // this.scene.add(entity.collider); // if you want to see the player collider
      this.scene.add(entity.arrow);

      entity.on('model:change', this.changeModel.bind(this));
    }
  }

  remove(entity: Unit) {
    this.entities.delete(entity);
    if (entity.view) {
      this.scene.remove(entity.view);
      entity.removeListener('model:change', this.changeModel.bind(this));
    }
  }

  renderAtCoords(x: number, y: number) {
    if (!this.map) {
      return;
    }

    this.map.render(x, y);
  }

  changeMap(mapId: number) {
    console.log('Load map', mapId);
    WorldMap.load(mapId).then((map: WorldMap) => {
      if (this.map) {
        this.scene.remove(this.map);
      }
      this.map = map;
      console.log("Map loaded", this.map)
      this.scene.add(this.map);
      this.renderAtCoords(this.player.position.x, this.player.position.y);
      this.player.emit('map:changed', this.map);
    });
  }



  changeModel(_unit: Unit, _oldModel: Unit, _newModel: Unit) {
    console.log('Model change', _unit, _oldModel, _newModel);
  }

  changePosition(position: THREE.Vector3) {
    // console.log('changePosition', this)
    this.renderAtCoords(position.x, position.y);
  }

  animate(delta: number, camera: THREE.PerspectiveCamera, cameraMoved: boolean) {
    this.animateEntities(delta, camera, cameraMoved);

    if (this.map !== null) {
      if (cameraMoved) {
        this.map.locateCamera(camera);
        // this.map.updateVisibility(camera);
      }
      // this.map.updateWorldTime(camera, this.map.mapID);
      if (this.map) {
        this.map.animate(delta, camera, cameraMoved);
      }
    }

    // Send delta updates to instanced M2 animation managers.
    M2Blueprint.animate(delta);
  }

  animateEntities(delta: number, camera: THREE.PerspectiveCamera, cameraMoved: boolean) {

    this.entities.forEach((entity) => {

      const { model } = entity;

      if (model === null || !model.animated) {
        return;
      }

      entity.update(delta);

      if (model.receivesAnimationUpdates && model.animations.length > 0) {
        model.animations.update(delta);
      }

      if (cameraMoved && model.billboards.length > 0) {
        model.applyBillboards(camera);
      }

      if (model.skeletonHelper) {
        model.skeletonHelper.update();
      }
    });
  }
}