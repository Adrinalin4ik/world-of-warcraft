// import * as THREE from "three";
import * as THREE from 'three';
import Player from "../classes/player";
import Unit from "../classes/unit";
import spots from "./spots";

import { EventEmitter } from "events";
import { GameHandler } from '../../network/game/handler';
import { GameSession } from '../../network/session';
import { collisionDebugView } from "../collision/debug-view";
import M2Blueprint from "../pipeline/m2/blueprint";
import { modelProbe } from "../pipeline/m2/model-probe";
import SkyDebug from "../pipeline/sky/debug";
import SkyManager from "../pipeline/sky/manager";
import { readMark } from "./saved-mark";
import { wmoDebug } from "./wmo-debug";
import WorldMap from "./map";

export default class World extends EventEmitter {
  public scene: THREE.Scene;
  public debugScene: THREE.Scene;
  public player: Player;
  public entities: Map<string, Unit> = new Map();
  public map: WorldMap | null = null;
  public session: GameSession;
  public game: GameHandler;
  public skyManager: SkyManager;
  /** The collision wireframe overlay, driven from `animate` and toggled from the debug panel. */
  public collisionDebug = collisionDebugView;
  private skyDebug: SkyDebug;
  // private skybox: THREE.Mesh;
  constructor(game: GameHandler) {
    super();
    console.log(game)
    console.log('WORLD GAME', game)
    window['world'] = this;
    this.scene = new THREE.Scene();
    this.scene.matrixAutoUpdate = false;

    // Stop `WebGLRenderer.render` calling `scene.updateMatrixWorld()` every frame
    // (three.module.js:17629). That call recurses the ENTIRE graph -- 31k nodes here -- to
    // recompute world matrices for terrain, static doodads and WMO geometry placed once and never
    // moved again. Measured at 4.4 ms; switching it off took the render section from 8.1 ms to
    // 1.9 ms with draw calls, triangles and GPU time all unchanged.
    //
    // Note `matrixAutoUpdate = false` above does NOT do this: it only skips composing an object's
    // LOCAL matrix. And setting `matrixWorldAutoUpdate = false` on individual static objects does
    // nothing either -- `Object3D.updateMatrixWorld` (three.core.js:12900) recurses into children
    // unconditionally, so the flag only gates that one object's multiply. The root is the only
    // place the walk can actually be stopped.
    //
    // `updateDynamicMatrices()` below now owns keeping everything that moves up to date.
    this.scene.matrixWorldAutoUpdate = false;
    this.debugScene = new THREE.Scene();
    this.debugScene.matrixAutoUpdate = false;

    // Added once and left in place: it is invisible and draws nothing until enabled, and its
    // vertices are already world-space, so it wants the scene root rather than any placed subtree.
    this.scene.add(this.collisionDebug.object);

    this.game = game;
    this.session = game.session;
    this.player = this.session.player;

    // Initialize sky manager
    this.skyManager = new SkyManager(this.scene);
    // Task 4 defect fix: this used to default to 'cone', a stub sky object that never read the
    // `MapLight`-published bands at all (its own `update()` always called `setDefaultColors()` and
    // `SkyManager` never called `setMapLight` on ANYTHING -- the sky was completely disconnected from
    // the light system before this task). 'procedural' is the dome the plan's Task 4 targets and the
    // one now actually wired to the published Light.dbc gradient stops -- defaulting to it is what
    // makes that work visible in the running game rather than only in unit tests.
    this.skyManager.initialize('procedural');
    
    // Initialize sky debug interface
    this.skyDebug = new SkyDebug(this.skyManager);

    this.player.on("map:change", this.changeMap.bind(this));
    this.player.on("position:change", this.changePosition.bind(this));
    // debugger;
    // let visualizer: MeshBVHVisualizer;
    // setInterval(() => {
    //   const staticGenerator = new StaticGeometryGenerator( this.scene );
    //   staticGenerator.attributes = [ 'position' ];
    //   const mergedGeometry = staticGenerator.generate();
    //   mergedGeometry.computeBoundsTree();

    //   if (ColliderManager.collidableMesh) {
    //     ColliderManager.collidableMesh.geometry = mergedGeometry;
    //     visualizer && visualizer.update();
    //   }

    //   if (!this.scene.children.find(x => x.name === 'MeshBVHVisualizer')) {
    //     // debugger;
        
    //     // mergedGeometry.boundsTree = new MeshBVH( mergedGeometry);
    //     ColliderManager.collidableMesh = new THREE.Mesh( mergedGeometry );
    //     ColliderManager.collidableMesh.name = 'MeshBVHVCollider'
    //     ColliderManager.collidableMesh.material = new THREE.MeshStandardMaterial({wireframe: true, color: new THREE.Color(0xffffff)});

    //     visualizer = new MeshBVHVisualizer( ColliderManager.collidableMesh, 10 );
    //     this.scene.add( visualizer );
    //     this.scene.add( ColliderManager.collidableMesh );
    //   }

      

      
    // }, 5000)
  }

  run() {
    this.add(this.player);
    // if (this.game.authenticated) {
    //   this.player = this.session.player;
    // }

    // this.player.worldport(this.player.mapId, [this.player.x, this.player.y, this.player.z]);
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
        this.player.worldport(spot.zoneId, spot.player.coords);
        this.player.rotation.set(
          spot.player.rotation[0],
          spot.player.rotation[1],
          spot.player.rotation[2]
        );
        setTimeout(() => {
          this.game.camera.position.set(spot.camera.coords[0], spot.camera.coords[1], spot.camera.coords[2])
          this.game.camera.rotation.set(
            spot.camera.rotation[0],
            spot.camera.rotation[1],
            spot.camera.rotation[2]
          );
        }, 5000)
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

        // The debug mark WINS over `lastLocation`. They are not the same thing: `lastLocation` is
        // only written when `worldport` actually changes MAP, so walking around never updates it --
        // it is the last zone entered, not the last place stood. The mark is an explicit "put me back
        // here", which is the whole reason to reload.
        const mark = readMark();

        if (mark) {
          this.player.worldport(mark.mapId, [mark.x, mark.y, mark.z]);
        } else {
          this.player.worldport(spot.zoneId, spot.coords);
        }
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

  /**
   * The current map's `MapLight`, or null before a map has loaded. `WorldMap` owns the instance (it
   * is recreated per zone change, see `changeMap`); this is just the one place anything outside
   * `WorldMap` (the sky system, the renderer's clear colour) needs to reach it.
   */
  get mapLight() {
    return this.map?.mapLight ?? null;
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
        // Removing the group from the scene only takes back the RENDERING. Collision, the material
        // registry and the loader refcounts are registered elsewhere and outlive it -- see
        // `WorldMap#unload` for what that cost, measured.
        this.map.unload();
        this.scene.remove(this.map);
      }
      this.map = map;
      console.log("Map loaded", this.map);
      this.scene.add(this.map);
      // Units outlive the map, and each map builds its own MaterialRegistry -- so re-adopt them
      // against the new one or they lose their light and fog uniforms (see `changeModel`).
      this.adoptEntityMaterials();
      this.renderAtCoords(this.player.position.x, this.player.position.y);
      this.player.emit("map:changed", this.map);
    });
  }

  /**
   * Hand a unit model's materials to the map's light + fog registry, and drop the outgoing one's.
   *
   * Terrain, WMOs and doodads reach the registry through the streaming path -- `TerrainManager`
   * calls `materialRegistry.addFrom` as each tile loads. A unit's model never does: `add()` puts it
   * straight into the scene. So nothing hands it fog uniforms and they keep their defaults, which
   * means `fogParams` stays all-zero and therefore `fogEnd = 0`.
   *
   * That is fatal rather than cosmetic. The M2 fragment shader ends with
   *
   *     if (blendingMode >= 2 && blendingMode < 6) { color.a *= 1.0 - fogFactor; }
   *
   * and `fogFactor` is derived from `(fogEnd - cameraDistance) / (fogEnd - fogStart)`. At
   * `fogEnd = 0` that degenerates, clamps to 1, and multiplies the body's alpha by ZERO -- so a
   * character whose geometry, skeleton, bind pose, textures, bounds and world matrix are all
   * provably correct draws nothing at all. (The same zero also trips the branch above it, which
   * replaces the colour with an unset white `fogColor`, so forcing the material opaque shows a
   * white silhouette rather than a textured model.)
   */
  changeModel(_unit: Unit, oldModel: any, newModel: any) {
    const registry = this.map?.materialRegistry;
    if (!registry) {
      // No map yet -- the player's model resolves before the first zone finishes loading. The
      // re-adoption in `changeMap` picks it up.
      return;
    }

    if (oldModel && oldModel.traverse) {
      oldModel.traverse((child: any) => {
        const material = child.material;
        if (!material) {
          return;
        }
        const materials = Array.isArray(material) ? material : [material];
        materials.forEach((entry) => registry.delete(entry));
      });
    }

    if (newModel) {
      registry.addFrom(newModel);
    }
  }

  /**
   * Re-register every live unit's materials with the incoming map's registry.
   *
   * `WorldMap` builds a fresh `MaterialRegistry` per zone, so everything adopted against the
   * previous one is dropped on the floor at a map change. Streamed content re-registers as it
   * reloads; units persist across the change and would otherwise silently lose their lighting --
   * and, per `changeModel`, their visibility.
   */
  adoptEntityMaterials() {
    const registry = this.map?.materialRegistry;
    if (!registry) {
      return;
    }

    this.entities.forEach((entity) => {
      const model = entity.model;
      if (model) {
        registry.addFrom(model);
      }
    });
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
      // `map.animate` itself calls `updateWorldTime` first thing, with the real per-frame `delta` --
      // a separate call here (as there used to be, with no delta) invoked MapLight.update() twice a
      // frame. Harmless while MapLight ignored everything past `camera`, but the interior-fog
      // crossfade now needs a real dt and would have advanced twice as fast for it.
      this.map.animate(delta, camera, cameraMoved);
    }

    // Update sky system. `setMapLight` every frame (not once) because `changeMap` swaps in a brand
    // new `MapLight` per zone -- the same staleness trap `WorldMap#adoptMaterial` already documents
    // for materials. Cheap: it is just a reference assignment when nothing has changed.
    //
    // `delta` is passed through as the cloud kernel's tick `dt` too (Task 6) -- the SAME per-frame
    // delta `map.animate` above already fed the interior-fog crossfade and the weather ramp. This
    // project has already shipped a duplicated per-frame `MapLight.update()` that halved a crossfade
    // rate by measuring `dt` twice; reusing `delta` here rather than a fresh clock is that fix
    // applying here too.
    this.skyManager.setMapLight(this.mapLight);
    // Task 6 Step 2: the WMO skybox's flood-reached predicate reads this frame's portal-flood
    // visibility flags off the WMOs `this.map.wmoManager` owns -- see `skybox/wmo-resolve.ts`. Cheap
    // reference hand-off, same reasoning as `setMapLight` just above.
    this.skyManager.setWmoManager(this.map?.wmoManager ?? null);
    this.skyManager.update(camera, this.map?.mapID || 0, delta);

    // Send delta updates to instanced M2 animation managers.
    M2Blueprint.animate(delta);

    // Centred on the player rather than the camera: the overlay exists to show what the MOVEMENT
    // cast sees, and the camera can be thirty yards away from that.
    this.collisionDebug.update(this.player.position);

    // Ticked every frame whether or not it is enabled: the frame counter is what "was this batch
    // drawn" is measured against, and it has to keep advancing for that answer to mean anything.
    modelProbe.tick(this.player.model);

    // Every frame so groups that stream in while a mode is active are overridden too. A no-op with
    // nothing selected.
    wmoDebug.sync(this.map as any);

    // LAST: everything above may have moved something. See the constructor for why the renderer no
    // longer does this itself.
    this.updateDynamicMatrices();
  }

  /**
   * Refresh world matrices for everything that can move, now that the renderer no longer walks the
   * whole scene graph each frame.
   *
   * Deliberately OPT-OUT rather than opt-in: every scene-root child is updated unless it is flagged
   * `isStaticSubtree`. Only `WorldMap` sets that flag, and it holds the streamed content -- terrain
   * tiles, static doodads, WMO geometry -- which is positioned once at placement and never again.
   * A new scene-root object (a spell effect, a nameplate) therefore updates correctly by default;
   * the failure mode of forgetting one is a little wasted time, not an object frozen in place.
   *
   * Inside the map, the movers are enumerated explicitly because the rest of that subtree is the
   * static bulk this exists to skip.
   */
  updateDynamicMatrices() {
    const children = this.scene.children;
    for (let i = 0, len = children.length; i < len; ++i) {
      const child = children[i] as any;
      if (child.isStaticSubtree === true) {
        continue;
      }
      child.updateMatrixWorld(true);
    }

    const map = this.map as any;
    if (!map) {
      return;
    }

    // Particles are re-positioned every frame by ParticleManager.
    if (map.particleGroup) {
      map.particleGroup.updateMatrixWorld(true);
    }

    // Animated doodads: skinning reads `bone.matrixWorld`, and this is also the exact set that
    // `DoodadManager#animate` runs `applyBillboards` over -- both mutate transforms under the
    // doodad, so the whole subtree is forced.
    if (map.doodadManager) {
      map.doodadManager.animatedDoodads.forEach((doodad: any) => {
        doodad.updateMatrixWorld(true);
      });
    }

    if (map.wmoManager) {
      map.wmoManager.entries.forEach((wmo: any) => {
        if (wmo.animatedDoodads) {
          wmo.animatedDoodads.forEach((doodad: any) => doodad.updateMatrixWorld(true));
        }
      });
    }
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
        model.animationManager.update(delta);
      }

      if (cameraMoved && model.billboards.length > 0) {
        model.applyBillboards(camera);
      }

      // if (model.skeletonHelper) {
      //   model.skeletonHelper.update();
      // }
    });
  }
}
