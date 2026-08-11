// import * as THREE from "three";
import * as THREE from 'three';
import Player from "../classes/player";
import Unit from "../classes/unit";
import spots from "./spots";

import { EventEmitter } from "events";
import { GameHandler } from '../../network/game/handler';
import { GameSession } from '../../network/session';
import { collisionDebugView } from "../collision/debug-view";
import { peerTrace } from "../movement/peer-trace";
import {
  beginAnimSection, endAnimSection, beginSection, endSection,
} from "../perf/anim-section";
import { animCounters } from "../pipeline/m2/anim/counters";
import { poseGatedInstance } from "../pipeline/m2/anim/pose-gate";
import { worldClock } from "../pipeline/m2/anim/world-clock";
import { modelProbe } from "../pipeline/m2/model-probe";
import SkyDebug from "../pipeline/sky/debug";
import SkyManager from "../pipeline/sky/manager";
import { fogDebug } from "./fog-debug";
import { lightDebug } from "./light-debug";
import { reactionFor } from "./faction";
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
  /**
   * Dense phase slot counter for unit models -- the same role `DoodadManager#nextPoseSlot` plays.
   *
   * Owned by `World` rather than by the map: units outlive `changeMap`, and a counter that restarted
   * per zone would hand a live unit's slot out twice.
   */
  private nextUnitPoseSlot = 0;
  /**
   * ONE function object for every unit's `model:change` subscription, so `remove` can actually
   * unsubscribe. `changeModel` takes the unit as its first argument and holds no per-unit state, so
   * a single shared listener is not merely adequate here -- it is what the signature was built for.
   */
  private readonly modelChangeHandler = (unit: Unit, oldModel: any, newModel: any) =>
    this.changeModel(unit, oldModel, newModel);
  // Stored for the same reason as `modelChangeHandler` above, and the reason is worth repeating
  // because these two arrived on a branch that had not seen that fix: `bind` returns a NEW function
  // object every call, so `removeListener(..., this.f.bind(this))` removes nothing at all. These
  // fire per stream-out, which is exactly when a listener that cannot be removed becomes a leak.
  private readonly modelAttachHandler = (unit: Unit, item: any) => this.adoptAttachedModel(unit, item);
  private readonly modelDetachHandler = (unit: Unit, item: any) => this.releaseAttachedModel(unit, item);
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
    // THE ENTERED CHARACTER IS RESOLVED FIRST, ahead of `add`, because `World#entities` is keyed by
    // guid and the player's own key has to be his REAL guid before he is filed under it. He was
    // constructed with the literal string `'Player'` (`network/session.ts:15`), so the server's own
    // create-object for him could never have matched -- see `add` for the other half.
    //
    // `session.offline` short-circuits ahead of the `protocol` getter, so `/game?offline=1` never
    // constructs a transport: reading `session.protocol` there would build them (which opens nothing --
    // see `network/session.ts` -- but the offline route's whole contract is that it never touches them).
    const entered = this.session.offline ? null : this.session.protocol.enteredCharacter;
    if (entered) {
      this.player.guid = entered.guid;
      this.player.name = entered.name;
      // HIS OWN BODY, in his own clothes, through the same `game/character/dress.ts` the
      // character-select stage uses -- see `Unit#setCharacterLook`. The ROSTER row is the source and not
      // the update-object, deliberately: `SMSG_CHAR_ENUM` carries equipment DISPLAY ids while the
      // update-object carries item ENTRY ids that need `Item.dbc` to become display ids, and the roster
      // has already arrived and been verified against the live server on the glue screen. Fire and
      // forget: it is an async DBC+`.m2`+bake chain, and until it lands the placeholder from `Player`'s
      // constructor stands in.
      this.player.setCharacterLook(entered).then((dressed) => {
        if (!dressed) {
          console.warn(
            `world: could not resolve a character look for ${entered.name} (race ${entered.race}, ` +
              `gender ${entered.gender}) -- the placeholder display model stands`,
          );
        }
      });
    }

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
    // ONLINE WORLD ENTRY, ahead of every debug spot below.
    //
    // The gate below is `!game.authenticated`, and `GameHandler#authenticated` is written in exactly
    // one place -- `GameHandler#join` (handler.js:91) -- which has NO callers anywhere in this repo:
    // the typed `WotlkWorldTransport#enterWorld` sends `CMSG_PLAYER_LOGIN` instead
    // (`protocol/wotlk/world.ts:158`). So on a real world entry that flag is false and, without this
    // branch, the player was worldported to `lastLocation` or to the hard-coded "dun murog" spot --
    // a debug leftover, not where the character stands. That is why online entry could not have
    // rendered the right zone even once.
    //
    // The roster is the source, deliberately, and it is authoritative enough: `SMSG_CHAR_ENUM`
    // carries the character's `mapId` and `position` (`wotlk/world-wire.ts#decodeCharEnum`), and it
    // has already arrived and been read before `CMSG_PLAYER_LOGIN` is even sent. So the map load
    // starts on the frame the world route mounts rather than waiting on a compressed update-object,
    // and the packets that follow are checkable against a position we knew independently.
    //
    // `entered` itself is resolved at the top of this method, because the guid and the character look
    // both have to be in place before `add`.
    if (entered) {
      console.info(
        `world: entering as ${entered.name} on map ${entered.mapId} (zone ${entered.zoneId}) at`,
        entered.position,
      );
      this.player.worldport(entered.mapId, entered.position);
      return;
    }

    if (!this.session.game.authenticated) {
      // FIRST, ahead of both `debugCoords` and `lastLocation`. The mark is an explicit "put me back
      // here" the user just clicked; the other two are older debugging leftovers, and `debugCoords`
      // in particular short-circuits everything below it -- which is why the mark appeared to do
      // nothing for anyone who still had that key set from an earlier session.
      const mark = readMark();

      if (mark) {
        this.player.worldport(mark.mapId, [mark.x, mark.y, mark.z]);
        return;
      }

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

        this.player.worldport(spot.zoneId, spot.coords);
      }
    }
  }

  add(entity: Unit) {
    // ONE UNIT PER GUID, and the eviction is not hypothetical. `applyUpdates` creates a `Unit` for any
    // guid it has not seen, and the world route mounts and the first compressed update-object arrive in
    // an order nothing guarantees -- so the server's create-object for our own character can land BEFORE
    // `run()` files the player. Without this the map entry would be overwritten and the earlier `Unit`
    // would stay in the scene with nothing referencing it: a second, undressed copy of the player,
    // standing in the same spot, for ever. Replacing the key silently was how a duplicate could exist
    // at all.
    const existing = this.entities.get(entity.guid);
    if (existing && existing !== entity) {
      console.warn(`world: guid ${entity.guid} already had a unit; removing the earlier one`);
      this.remove(existing);
    }
    this.entities.set(entity.guid, entity);
    if (entity.view) {
      this.scene.add(entity.view);
      // this.scene.add(entity.collider); // if you want to see the player collider
      // this.scene.add(entity.arrow);

      entity.on('model:change', this.modelChangeHandler);
      // The SECOND door into the same registry, and it exists because the first one closes too
      // early. `model:change` fires when the body lands; a weapon, pauldron pair or helm is parented
      // to one of that body's BONES several fetches later (`character/dress.ts#attachCharacterItems`),
      // so it was never in the model `changeModel` walked. See `adoptAttachedModel`.
      entity.on('model:attach', this.modelAttachHandler);
      entity.on('model:detach', this.modelDetachHandler);
    }
  }

  /**
   * Drop every unit the server streamed to us, keeping our own player.
   *
   * `entities` is the session's guid-keyed registry and nothing else ever empties it, so without
   * this a second connection on the same page starts with the previous one's creatures standing in
   * the scene at their last known positions, animating, under guids the new connection is about to
   * re-create -- which `add`'s duplicate eviction would then have to untangle one at a time, and
   * which `animateEntities` pays for every frame in between.
   *
   * The player stays: `World#run` files him once (index.ts:156) and the world route may remount
   * without him ever having left.
   */
  clearRemoteEntities() {
    const doomed: Unit[] = [];
    this.entities.forEach((entity) => {
      if (entity !== this.player) {
        doomed.push(entity);
      }
    });
    doomed.forEach((entity) => this.remove(entity));
  }

  /**
   * OUR CURRENT TARGET, or null.
   *
   * The client-side half of the selection. The wire half is `CombatHandler#select`, which is the
   * only thing allowed to send `CMSG_SET_SELECTION`; `setTarget` below is the only thing that calls
   * it, so what this holds and what the server believes cannot drift apart.
   */
  public target: Unit | null = null;

  /**
   * Pick a unit (or null to clear), tell the server, and announce it.
   *
   * FIRES `target:change` AFTER the state is written and after the query is asked for, which is
   * benilla's order too (`crates/benilla/src/ui_unit.rs:672-676` sets the unit and only then fires
   * `PLAYER_TARGET_CHANGED`), so a handler that reads the new target during the event sees it.
   *
   * The CREATURE QUERY is fired here because this is the first moment a name is needed: there is no
   * `UNIT_FIELD_NAME`, and a wolf's name and its elite/rare classification both arrive only in
   * `SMSG_CREATURE_QUERY_RESPONSE`. Querying every creature that streams into view instead would be
   * ~40 round trips per grid for names nothing displays.
   */
  /**
   * How `unit` feels about us, on the client's 1..8 scale, or null while `FactionTemplate.dbc` has
   * not landed. Memoised on the unit; see `world/faction.ts#reactionFor`.
   */
  reactionFor(unit: Unit): number | null {
    return reactionFor(unit, this.player);
  }

  setTarget(unit: Unit | null) {
    if (this.target === unit) {
      return;
    }
    this.target = unit;
    this.game.objectHandler.combatHandler.select(unit ? unit.guid : null);
    if (unit && unit.fields.entry) {
      this.game.objectHandler.combatHandler.queryCreature(unit.fields.entry, unit.guid);
    }
    this.emit('target:change', unit);
  }

  remove(entity: Unit) {
    // A target that streams out or dies-and-decays stops being a target. Without this the UI would
    // keep painting a unit that is no longer in the scene, and `TargetFrame` would never hide.
    if (this.target === entity) {
      this.setTarget(null);
    }
    this.entities.delete(entity.guid);
    if (entity.view) {
      this.scene.remove(entity.view);
      this.scene.remove(entity.arrow);
      // `this.modelChangeHandler`, NOT `this.changeModel.bind(this)`. `bind` returns a NEW function
      // object every call, so the old line removed nothing -- it could not, because the listener
      // `add` registered was a different (also freshly bound) function. Every removed unit kept a
      // live `model:change` subscription calling back into this world for ever. Harmless while
      // nothing was ever removed; a per-stream-out leak now that units come and go.
      entity.removeListener('model:change', this.modelChangeHandler);
      entity.removeListener('model:attach', this.modelAttachHandler);
      entity.removeListener('model:detach', this.modelDetachHandler);
    }
    // Hand the outgoing model's materials back out of the map's light/fog registry, the same way
    // `changeModel` does for a model being replaced -- otherwise the registry accumulates materials
    // for units that are gone and re-uniforms them every frame.
    this.changeModel(entity, entity.model, null);
    entity.release();
  }

  /**
   * Hand ONE attached item model's materials to the map's light + fog registry.
   *
   * THIS IS THE FIX FOR "SHOULDERS, HELMS AND WEAPONS RENDER PURE WHITE", and it is `changeModel`'s
   * own failure mode arriving one seam later. That method's doc already spells the mechanism out for
   * a unit's BODY: nothing else hands a unit's materials fog uniforms, so `fogParams` stays all-zero
   * and `fogColor` stays at its constructor default -- and `new THREE.Color()` is **white**. With
   * `fogParams = (0,0,0,0)` the shader's `f4 = min(max(d*0 + 0, 0), 1)` is 0, so `fogFactor` is
   * `(1 - 0) * fogModifier = 1`, and `applyFog`'s first branch is `color.rgb = mix(color.rgb,
   * fogRgb, 1.0)` -- the fragment is replaced by that white outright, at every distance, whatever
   * the texture says.
   *
   * `changeModel` fixed exactly this for the body and could not fix it for the attachments: it runs
   * on `model:change`, which `Unit`'s `model` setter emits the instant the body is swapped in, while
   * `attachCharacterItems` parents the helm and the two pauldrons to that body's bones one `.m2`
   * fetch later. The registry walk had already happened and never saw them.
   *
   * MEASURED, on a Stormwind guard (`CreatureDisplayInfo` 3167, `HELM_PLATE_B_01STORMWIND_HUM.M2` +
   * `L/RSHOULDER_PLATE_B_01.M2`) in Northshire, by rewriting those materials' fragment output in the
   * browser: `gl_FragColor = texture2D(textures[0], coordinates[0])` drew the correct blue-plumed
   * Stormwind helm, and `gl_FragColor = applyFog(<that same sample>)` drew flat 255-white. So the
   * texture, the UVs, the geometry and the sampler were all already right and fog alone was the
   * whitener. The same guard's tabard, gloves and boots were correct throughout because they are
   * painted into the BODY atlas, and the body is registered.
   */
  adoptAttachedModel(_unit: Unit, item: any) {
    // No map yet is not a failure: `changeMap`'s `adoptEntityMaterials` re-registers every live
    // entity's whole model subtree, and by then the attachment is a child of it.
    this.map?.materialRegistry?.addFrom(item);
  }

  /** Drop one attached item model's materials, mirroring `changeModel`'s release of an old body. */
  releaseAttachedModel(_unit: Unit, item: any) {
    const registry = this.map?.materialRegistry;
    if (!registry || !item?.traverse) {
      return;
    }
    item.traverse((child: any) => {
      const material = child.material;
      if (!material) {
        return;
      }
      const materials = Array.isArray(material) ? material : [material];
      materials.forEach((entry: any) => registry.delete(entry));
    });
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
    // FIRST, before anything reads it. Every animation consumer -- terrain doodads, WMO doodads,
    // unit models, global sequences -- indexes off this one monotonic clock, so it has to advance
    // exactly once per frame and it has to advance before the first read. See `anim/world-clock.ts`
    // for why this is not a per-manager field.
    worldClock.advance(delta);

    // THE BREAKDOWN. `world.animate` was a single span holding everything below it, and Task 9's
    // movement round recorded that the number could not be reasoned about until its parts were
    // separated (five samples of one unchanged build spanned 7.3-15.5 ms). These five sub-spans are
    // that separation, and they are deliberately EXHAUSTIVE of `animate` -- every statement below
    // sits inside exactly one of them, so `w.entities + w.vis + w.map + w.sky + w.debug +
    // w.matrices` reconstructs `world.animate` to within the timestamp overhead. If a statement is
    // ever added outside all six, the sum stops matching the total and that is the intended tell.
    //
    // `w.vis` is separate from `w.map` on purpose: it is the only one gated on `cameraMoved`, so it
    // reads ~0 on a still frame and its true cost is invisible in any average that mixes the two.
    // That gating is also why the HUD's `chunks` row reads 0 on a still frame -- see the report.
    beginSection('w.entities');
    this.animateEntities(delta, camera, cameraMoved);
    endSection('w.entities');

    if (this.map !== null) {
      if (cameraMoved) {
        beginSection('w.vis');
        this.map.locateCamera(camera);
        this.map.updateVisibility(camera);
        endSection('w.vis');
      }
      // `map.animate` itself calls `updateWorldTime` first thing, with the real per-frame `delta` --
      // a separate call here (as there used to be, with no delta) invoked MapLight.update() twice a
      // frame. Harmless while MapLight ignored everything past `camera`, but the interior-fog
      // crossfade now needs a real dt and would have advanced twice as fast for it.
      // Holds MapLight's per-frame pass, the portal flood, and the doodad and WMO animation loops --
      // so it OVERLAPS the `anim` span, which those two loops also open. `anim` is the cross-cutting
      // total; `w.map` is the positional one. Both are correct and they are not additive.
      beginSection('w.map');
      this.map.animate(delta, camera, cameraMoved);
      endSection('w.map');
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
    beginSection('w.sky');
    this.skyManager.setMapLight(this.mapLight);
    // Task 6 Step 2: the WMO skybox's flood-reached predicate reads this frame's portal-flood
    // visibility flags off the WMOs `this.map.wmoManager` owns -- see `skybox/wmo-resolve.ts`. Cheap
    // reference hand-off, same reasoning as `setMapLight` just above.
    this.skyManager.setWmoManager(this.map?.wmoManager ?? null);
    this.skyManager.update(camera, this.map?.mapID || 0, delta);
    endSection('w.sky');

    // The four debug syncs below are grouped under one span because they share one question: what
    // does the instrumentation cost when nothing is switched on? Every one of them is a no-op with
    // its own overlay disabled, and this span is what proves it rather than assuming it. The
    // collision overlay in particular is NOT free when enabled, which is why the round's baseline
    // is taken with it off.
    beginSection('w.debug');

    // No M2Blueprint.animate here any more: global sequences are a pure function of world time and
    // instances are clock-indexed, so there is no shared timeline left to tick. See M2Blueprint.
    // Centred on the player rather than the camera: the overlay exists to show what the MOVEMENT
    // cast sees, and the camera can be thirty yards away from that.
    this.collisionDebug.update(this.player.position);

    // Ticked every frame whether or not it is enabled: the frame counter is what "was this batch
    // drawn" is measured against, and it has to keep advancing for that answer to mean anything.
    modelProbe.tick(this.player.model);

    // Every frame so groups that stream in while a mode is active are overridden too. A no-op with
    // nothing selected.
    wmoDebug.sync(this.map as any);

    // AFTER `map.animate` above, which runs the per-frame light pass -- that pass re-copies
    // `fogParams` from MapLight, so neutralising fog before it would be overwritten immediately.
    fogDebug.sync(this.map as any);
    lightDebug.sync(this.map as any);
    endSection('w.debug');

    // LAST: everything above may have moved something. See the constructor for why the renderer no
    // longer does this itself.
    beginSection('w.matrices');
    this.updateDynamicMatrices();
    endSection('w.matrices');

    // THE RENDERED TRANSFORM, sampled after the matrices are final and nowhere earlier.
    //
    // This is the instrument the previous movement round did not have, and its absence is why a
    // measurement that came out numerically perfect coexisted with a visibly teleporting peer: that
    // round sampled the dead-reckon's own output, which is an INPUT to the transform. Anything between
    // the two -- a ground resolve, a yaw ease, a second writer -- is invisible from there. `peerTrace`
    // reads `view.matrixWorld` here instead, which is the matrix the draw call uses.
    //
    // Free when the trace is off: `recordRender` returns on its first line, and the loop is behind the
    // same flag so a session that never enables it does not even walk the entity map.
    if (peerTrace.enabled) {
      this.entities.forEach((entity) => {
        // PEERS AND OURSELVES ONLY, and the restriction is not thrift -- it is what makes the ring
        // usable. The first capture sampled all 83 streamed entities and filled the 8000-row history
        // in under two seconds, evicting every packet row before the run ended: an instrument that
        // measured itself out of existence. Creatures are the spline path's business and have their
        // own capture.
        if (!entity.isPlayer && entity.remoteMotion === null) {
          return;
        }
        const inst = entity.model?.instanceAnim ?? null;
        peerTrace.recordRender(
          entity.guid,
          entity.view.matrixWorld,
          entity.locomotionFlags(),
          entity.isPlayer ? entity.locomotionSpeed(delta) : (entity.remoteMotion?.speed ?? 0),
          inst?.current?.id ?? -1,
          inst?.playbackRate ?? 0,
        );
      });
    }
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

    // WHY THIS WALK EXISTS -- do not delete it. `M2#applyPose` writes per-bone LOCAL transforms
    // (`anim/pose.ts` derives why local is the correct form), and this is what accumulates them into
    // `bone.matrixWorld`, which is in turn the only thing three's `Skeleton#update()` reads when it
    // builds the palette during `render()`. Without this walk the solver runs, the counters tick,
    // and every animated doodad stands in bind pose.
    //
    // Plan section 5.1.4 and Task 13's brief both called for dropping it, on the belief that the
    // evaluator writes bone WORLD matrices into the palette itself and three then repeats the
    // hierarchy walk. It does not, and it cannot -- see `anim/pose.ts` for the two independent
    // reasons the direct-palette route does not work in three 0.185. That optimization is void.
    //
    // It IS gated, though, which is the part the plan got right for the wrong reason: only a doodad
    // whose bones actually moved this frame needs re-accumulating. `DoodadManager#animate` stamps
    // `poseFrame` when `applyPose` or `applyBillboards` touched a doodad, so everything the
    // visibility gate rejected, the decimation gate skipped or the bone budget denied is passed over
    // here too. This walk is O(bones) per doodad -- the same order as `solveBones` -- so leaving it
    // ungated would have handed back most of what those gates save.
    const frameIndex = worldClock.frameIndex;

    if (map.doodadManager) {
      map.doodadManager.animatedDoodads.forEach((doodad: any) => {
        if (doodad.poseFrame === frameIndex) {
          doodad.updateMatrixWorld(true);
        }
      });
    }

    // Same `poseFrame` gate as the terrain doodads above. It was an unconditional walk while the WMO
    // set was always empty (Task 13 left the registration commented out); now that interior doodads
    // actually register, an ungated walk would re-accumulate every prop in every loaded building
    // every frame -- including the ones the portal flood, the decimation gate and the bone budget
    // just decided not to touch.
    if (map.wmoManager) {
      map.wmoManager.entries.forEach((wmo: any) => {
        if (wmo.animatedDoodads) {
          wmo.animatedDoodads.forEach((doodad: any) => {
            if (doodad.poseFrame === frameIndex) {
              doodad.updateMatrixWorld(true);
            }
          });
        }
      });
    }
  }

  /**
   * Pose every unit -- creatures, NPCs, the player's own avatar.
   *
   * HOW UNITS ARE GATED, and why it is not what the brief specified.
   *
   * The brief exempted units from decimation AND from the bone budget outright, on the grounds that
   * there are few of them, they are what the player looks at, and a held pose on a moving creature
   * reads as a stutter where a held pose on a distant flag does not. Half of that survives.
   *
   *   * The BONE BUDGET is not applied, and that is the brief's argument holding. The budget is the
   *     one gate that can hard-freeze the object under the crosshair, and which instances it freezes
   *     is `Map` insertion order -- arbitrary, and unstable across a relog. Charging units against
   *     the doodad budget would also let a courtyard of braziers starve the creature fighting in it,
   *     which is precisely backwards.
   *   * DECIMATION is applied, because the brief's argument does not reach it. `decimationPeriod`
   *     returns 1 below `NEAR_YD` (40 yd), so posing every unit within 40 yd every single frame is
   *     what this code already does -- the gate costs a distance calculation and changes nothing for
   *     the creature you are fighting. What it buys is the crowd at 120 yd across a city square,
   *     where a quarter-rate pose is invisible and full rate is not free.
   *   * The DRAW gate is applied. Nothing wrote `visible` on unit models before, so today it only
   *     rejects a model still streaming in -- but a unit model that is not drawn must not be posed,
   *     and wiring that in later should not also require remembering this loop.
   *
   * WHAT IS STILL UNPROTECTED, stated plainly: a raid boss with a hundred NEARBY units. Every one of
   * them is inside 40 yd, so decimation gives back nothing there, and with no budget the frame pays
   * for all hundred. Distance decimation is simply the wrong instrument for a dense near cluster;
   * the right one is a budget with a priority order (nearest first, target and player exempt), which
   * needs a measured bone count to size and a sort this loop does not do. Units now feed
   * `animCounters`, so the HUD's `resident` / `posed` / `bonesSolved` rows report that population
   * from this task on -- measure before adding a gate whose failure mode is a stuttering boss.
   */
  animateEntities(
    delta: number,
    camera: THREE.PerspectiveCamera,
    cameraMoved: boolean
  ) {
    const worldClockMs = worldClock.ms;
    const frameIndex = worldClock.frameIndex;
    const camPos = camera.position;

    // One of the three call sites of the `'anim'` CPU span -- the others are `DoodadManager#animate`
    // and `WMOManager#animate`. `CpuSections` SUMS spans of the same name within a frame, so the
    // three report one total, which is the number the plan's <= 2 ms acceptance gate is stated
    // against. `world.animate` is emphatically not a substitute: it also holds visibility, MapLight,
    // the sky system, the portal flood and the collision debug overlay.
    beginAnimSection();

    this.entities.forEach(entity => {
      const { model } = entity;

      // MOTION FIRST, AND UNGATED. `entity.update` is where a unit's network motion is integrated --
      // the spline sampler for a creature, the dead reckoning for a peer player -- and NONE of that
      // is animation. It used to sit below the `model.animated` gate, and the consequence was
      // measured live rather than reasoned about: two accounts in Elwynn, one walking toward the
      // other, 185 relayed `MSG_MOVE_*` reaching the observer and ZERO integration frames for the
      // mover. Every one of those packets was drawn as a snap, 0.93 yd apart, at the sender's ragged
      // cadence (measured arrival gaps 139, 112, 210, 72, 223, 91, 176, 107, 279, 41, 198, 157, 391,
      // 0, 32 ms) -- a peer that teleports forward a yard at a time and stands still in between,
      // which is the reported stall-and-rush at its most extreme.
      //
      // It bit a peer because a character's model is not `animated` until it has streamed AND been
      // classified, which is seconds after the first movement packet arrives; the earlier report
      // named the same hazard for any unit with a static model. A body's position must not depend on
      // whether its skeleton has keyframes.
      entity.update(delta, camPos);

      // Same two-part test `DoodadManager#loadDoodad` documents: `model.animated` is the POSING
      // predicate (ModelAnim.classify), and billboarding is a separate reason to need a per-frame
      // visit. A billboard-only model would otherwise skip `applyBillboards` and freeze facing bind
      // orientation.
      if (model === null || model === undefined) {
        return;
      }

      // A unit's model can become animated AFTER it loaded: an external `.anim` merge is what
      // finally gives a creature whose authoring lives entirely in sibling files something to
      // sample (`M2#syncMergedAnimation`). This is the pull side of that flip, and it has to sit
      // ABOVE the gate below -- the gate is exactly what would keep such a model out for ever.
      // Steady-state cost is one boolean compare per unit per frame; the method itself is not
      // entered once the answer stops changing.
      if (!model.animated) {
        model.syncMergedAnimation();
      }

      if (!model.animated && model.billboards.length === 0) {
        return;
      }

      // Gait selection, AFTER `entity.update` (the spline follower writes `view.position` in there,
      // and the non-player speed leg differences that position) and BEFORE anything samples the
      // instance below. The single call site: nothing else drives a unit's locomotion.
      //
      // Deliberately ABOVE the DRAW gate, unlike the material and bone work. Gait is state, not a
      // pose: skipping it for an off-screen unit would leave it standing when it walks back into
      // view, and the measured-displacement leg would then difference across the whole gap and read
      // a teleport.
      //
      // Steady-state cost is a two-component subtract, a sqrt and a reference comparison. The
      // `resolve` walk -- a full linear scan of the sequence table per candidate -- runs only when
      // the gait BUCKET changes, because `updateLocomotion` memoises the resolved sequence against
      // the candidate list it came from. Without that memo it would run for every unit every frame.
      entity.updateLocomotion(delta);

      // Membership here does NOT imply `instanceAnim` is non-null -- a billboard-only model reaches
      // this loop for `applyBillboards` alone and never allocates an instance.
      const inst = model.instanceAnim;

      // Assigned lazily: a unit's model arrives asynchronously, long after `add()`, so there is no
      // single registration site to hang this on the way the doodad managers have.
      if (inst && model.poseSlot < 0) {
        model.poseSlot = this.nextUnitPoseSlot++;
      }

      if (inst) {
        animCounters.resident++;
      }

      // DRAW gate. NO residency cycle above it, unlike the doodads: a unit's sequence is chosen by
      // gameplay through `Unit#setAnimation`, not rolled from the shared variation stream, and
      // running `cycleDoodad` here would re-roll a creature's animation out from under the server
      // every time its current one ended.
      if (model.visible === false) {
        if (inst) {
          animCounters.skipped++;
        }
        return;
      }

      // Non-bone channels behind the DRAW gate only -- same split as the doodad paths.
      if (inst) {
        animCounters.materialsEvaluated++;
        model.evaluateMaterialChannels(worldClockMs);
      }

      // Bone work behind `useSkinning`: a model animating only UV / transparency / vertex colour has
      // its bones orphaned from the scene graph (`createMesh` parents the root bones only on the
      // skinning branch), so solving them writes into objects nothing reads.
      if (inst && model.useSkinning) {
        // `null` budget: units are exempt. See this method's doc.
        poseGatedInstance(model, inst, camPos, frameIndex, worldClockMs, null);
      } else if (inst) {
        animCounters.skipped++;
      }

      if (cameraMoved && model.billboards.length > 0) {
        model.applyBillboards(camera);
      }

      // NO `poseFrame` stamp and no gated walk for units, and this cost is KNOWINGLY retained.
      //
      // `entity.view` is a direct child of the scene root, so `updateDynamicMatrices` gives it an
      // unconditional forced `updateMatrixWorld(true)` -- the same O(bones) accumulate the doodad
      // paths gate on `poseFrame`. So a distant unit that the decimation gate just skipped still
      // pays for the walk, which does blunt decimation for exactly the population it was adopted
      // for. The earlier claim here ("units move every frame anyway, so there is nothing to skip")
      // was too glib, and is corrected rather than acted on, because the gate is NOT the same shape
      // as the doodad one:
      //
      // A doodad's world transform is fixed at placement, so its bone subtree only needs
      // re-accumulating when its BONES moved. A unit's does not: skinning draws
      // `bone.matrixWorld . boneInverse` against `mesh.matrixWorld^-1`, so the moment the unit's own
      // transform changes, stale bone world matrices smear the model regardless of whether it was
      // posed. The correct predicate is therefore `posed OR moved`, not `posed`, and the genuinely
      // skippable set is only units that are BOTH un-posed AND stationary -- which excludes every
      // walking creature and, since `decimationPeriod` is 1 inside 40 yd, every nearby idle one too.
      //
      // Implementing it means lifting entity views out of the generic root-child loop and tracking
      // per-unit movement there. That is worth doing when the unit count justifies it; the entity
      // map currently holds the player. Task 20 has the measurement (`animCounters` now includes
      // units) to decide.

      // if (model.skeletonHelper) {
      //   model.skeletonHelper.update();
      // }
    });

    endAnimSection();
  }
}
