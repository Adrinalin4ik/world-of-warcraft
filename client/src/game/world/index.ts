// import * as THREE from "three";
import * as THREE from 'three';
import Player from "../classes/player";
import spots from "./spots";
import Unit from "../classes/unit";

import M2Blueprint from "../pipeline/m2/blueprint";
import WorldMap from "./map";
import { EventEmitter } from "events";
import { GameSession } from '../../network/session';
import { GameHandler } from '../../network/game/handler';
export default class World extends EventEmitter {
  public scene: THREE.Scene;
  public debugScene: THREE.Scene;
  public player: Player;
  public entities: Map<string, Unit> = new Map();
  public map: WorldMap | null = null;
  public session: GameSession;
  public game: GameHandler;

  // private skybox: THREE.Mesh;
  constructor(game: GameHandler) {
    super();
    console.log(game)
    console.log('WORLD GAME', game)
    this.scene = new THREE.Scene();
    this.scene.matrixAutoUpdate = false;
    this.debugScene = new THREE.Scene();
    this.debugScene.matrixAutoUpdate = false;

    this.game = game;
    this.session = game.session;
    this.player = this.session.player;

    this.player.on("map:change", this.changeMap.bind(this));
    this.player.on("position:change", this.changePosition.bind(this));
  }

  run() {
    this.add(this.player);
    // if (this.game.authenticated) {
    //   this.player = this.session.player;
    // }

    this.player.worldport(this.player.mapId, [this.player.x, this.player.y, this.player.z]);
    // var geometry = new THREE.CubeGeometry(1000, 1000, 1000);
    // var cubeMaterials = [
    //   new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load('/yonder_ft.jpg'), side: THREE.DoubleSide }), //front side
    //   new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load('/yonder_bk.jpg'), side: THREE.DoubleSide }), //back side
    //   new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load('/yonder_up.jpg'), side: THREE.DoubleSide }), //up side
    //   new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load('/yonder_dn.jpg'), side: THREE.DoubleSide }), //down side
    //   new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load('/yonder_rt.jpg'), side: THREE.DoubleSide }), //right side
    //   new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load('/yonder_lf.jpg'), side: THREE.DoubleSide }) //left side
    // ];

    // var cubeMaterial = new THREE.MeshFaceMaterial(cubeMaterials);
    // this.skybox = new THREE.Mesh(geometry, cubeMaterial);
    // this.skybox.rotation.set(
    //   -Math.PI / 2,
    //   Math.PI,
    //   Math.PI,
    // );
    // this.skybox.name = "Skybox"
    // this.scene.add(this.skybox);
    if (!this.session.game.authenticated) {
      const loadedSpot = localStorage.getItem("debugCoords");
      if (loadedSpot) {
        const spot: any = JSON.parse(loadedSpot);
        // "{"zoneId":1,"coords":[-3685.162399035418,-4526.337356788462,16.28410000000111]}"
        this.player.worldport(spot.zoneId, spot.coords);
        this.player.rotation.set(
          spot.rotation[0],
          spot.rotation[1],
          spot.rotation[2]
        );
      } else {
        // let spot: any = spots[spots.length - 2]
        let spot: any = spots.find(x => x.id === "dun murog")
        // let spot: any = spots.find(x => x.id === 2)
        // let spot: any = spots.find(x => x.id === "stormwind")
        // let spot: any = spots.find(x => x.id === "ogrimar")
        // let spot: any = spots.find(x => x.id === "daggercap_bay");
        // let spot: any = spots.find(x => x.id === "north_bay");
        // let spot: any = spots.find(x => x.id === "naxramas");
        // let spot: any = spots.find(x => x.id === "dalaran");

        const lastLocation = localStorage.getItem("lastLocation");

        if (lastLocation) {
          spot = JSON.parse(lastLocation);
          console.log(spot)
        }

        this.player.worldport(spot.zoneId, spot.coords);
      }
    }
  }

  add(entity: Unit) {
    this.entities.set(entity.guid, entity);
    if (entity.view) {
      this.scene.add(entity.view);
      // this.scene.add(entity.collider); // if you want to see the player collider
      // this.scene.add(entity.arrow);

      entity.on("model:change", this.changeModel.bind(this));
    }
  }

  remove(entity: Unit) {
    this.entities.delete(entity.guid);
    if (entity.view) {
      this.scene.remove(entity.view);
      this.scene.remove(entity.arrow);
      entity.removeListener("model:change", this.changeModel.bind(this));
    }
  }

  renderAtCoords(x: number, y: number) {
    if (!this.map) {
      return;
    }

    this.map.render(x, y);
  }

  changeMap(mapId: number) {
    console.log("Load map", mapId);
    WorldMap.load(mapId).then((map: WorldMap) => {
      if (this.map) {
        this.scene.remove(this.map);
      }
      this.map = map;
      console.log("Map loaded", this.map);
      this.scene.add(this.map);
      this.renderAtCoords(this.player.position.x, this.player.position.y);
      this.player.emit("map:changed", this.map);
    });
  }

  changeModel(_unit: Unit, _oldModel: Unit, _newModel: Unit) {
    // console.log("Model change", _unit, _oldModel, _newModel);
  }

  changePosition(position: THREE.Vector3, _rotation: THREE.Vector3) {
    this.renderAtCoords(position.x, position.y);
    // this.skybox.position.set(position.x, position.y, 100)
  }

  animate(
    delta: number,
    camera: THREE.PerspectiveCamera,
    cameraMoved: boolean
  ) {
    this.animateEntities(delta, camera, cameraMoved);

    if (this.map !== null) {
      if (cameraMoved) {
        this.map.locateCamera(camera);
        this.map.updateVisibility(camera);
      }
      // this.map.updateWorldTime(camera, this.map.mapID);
      this.map.animate(delta, camera, cameraMoved);
    }

    // Send delta updates to instanced M2 animation managers.
    M2Blueprint.animate(delta);
  }

  animateEntities(
    delta: number,
    camera: THREE.PerspectiveCamera,
    cameraMoved: boolean
  ) {
    this.entities.forEach(entity => {
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
