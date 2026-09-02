// import * as THREE from "three";
import * as THREE from 'three';
import Player from "../classes/player";
import Unit from "../classes/unit";
import spots from "./spots";

import { EventEmitter } from "events";
import { GameHandler } from '../../network/game/handler';
import { GameSession } from '../../network/session';
import { collisionWorld } from "../collision/collision-world";
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
import { reactionFor, REACTION_NEUTRAL } from "./faction";
import { HoverHighlight } from "./hover-highlight";
import { SelectionRing } from "./selection-ring";
import { LevelUpEffect } from "./level-up-effect";
import { SpellKitEffects } from "./spell-kit-effects";
import { spellData } from "../pipeline/dbc/spell-data";
import { SpellMissiles } from "./spell-missile";
import { installSpellFxScaleKnob } from "./spell-fx-scale";
import GameObjectSparkle from './game-object-sparkle';
import SessionGuard from './session-guard';
import ModelFade from './model-fade';
import { QuestMarkers } from "./quest-markers";
import { NameplateConfig, Nameplates } from "./nameplates";
import { FloaterSpawn, FloatingCombatText, MAX_FLOATERS, WordSource } from "./floating-text";
import {
  COLOR_SPELL_GOLD, meleeText, spellMissText, spellText,
} from "../classes/combat-text";
import type { SpellDamageEvent } from "../../network/game/object/combat-log";
import { readMark } from "./saved-mark";
import { wmoDebug } from "./wmo-debug";
import WorldMap from "./map";

/**
 * `ObjectType.Unit` -- a CREATURE. `4` is a player, and the combat-facing rule deliberately does not
 * touch one; see `animateEntities`.
 */
const OBJECT_TYPE_CREATURE = 3;

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
  /** The ground selection ring under the current target. Built in the constructor, ticked in `animate`. */
  public selectionRing: SelectionRing;

  /**
   * THE LEVEL-UP BURST. `Spells\LevelUp\LevelUp.m2`, which `SpellVisualEffectName.dbc` row 21 names
   * `HARDCODED Unit Level Up` -- see `level-up-effect.ts` for the whole source trail and for why the
   * idle cost is one array-length compare.
   *
   * Public so `ui/level-up-bridge.ts` can play it: the packet arrives on the network thread of the
   * session, not in the render loop, and the effect has to be started from there.
   */
  public levelUpEffect: LevelUpEffect;

  /**
   * THE SPELL VISUAL KIT EFFECTS -- the attach-point models and ground plants a cast hangs on a
   * unit. Public because the cast edges arrive in the network layer
   * (`network/game/object/spells.ts`), which is where the pose is already armed from, and routing
   * them through `playSpellKit` below is what supplies the particle manager they need.
   */
  public spellKitEffects: SpellKitEffects;

  /**
   * THE PROJECTILES -- the owner's "основная вещь". Public for the same reason
   * `spellKitEffects` is: the launch edge is `SMSG_SPELL_GO` in the network layer.
   */
  public spellMissiles: SpellMissiles;

  /** The glow on a quest objective object. See `game-object-sparkle.ts`. */
  public gameObjectSparkle: GameObjectSparkle;

  /** NPC windows and the loot end when the player walks away. See `session-guard.ts`. */
  public sessionGuard = new SessionGuard();

  /**
   * Units fade in when they arrive and out when they stream away. See `world/model-fade.ts`.
   *
   * Constructed with `remove` bound, because the fade owns the moment a departing unit actually leaves
   * the scene -- the ramp has to finish first.
   */
  public modelFade = new ModelFade((unit: Unit) => this.remove(unit));

  /** See the wiring block in `animate`. */
  private sessionGuardWired = false;

  /**
   * THE `!` AND `?` OVER A QUESTGIVER'S HEAD -- models on a bone, not sprites. See
   * `world/quest-markers.ts` for the whole render law and for why the nameplate band is not involved.
   */
  public questMarkers: QuestMarkers = new QuestMarkers();


  /** See the instrument beside `questMarkers.update` -- published once, not per frame. */
  private questMarkerProbePublished = false;

  /**
   * The guid -> `DIALOG_STATUS` map the markers are drawn from, or null.
   *
   * INSTALLED BY THE BRIDGE rather than read from here, deliberately: `game/ui/quest-bridge.ts` owns
   * the handler and is only attached on a real session, so an offline world leaves this null and the
   * marker pass early-outs. Reaching into `game.objectHandler` from the world would touch transports
   * the offline route contracts never to construct -- the same rule `world-ui.ts` states for its own
   * gated bridges.
   */
  public questMarkerStatuses: Map<string, number> | null = null;
  /**
   * The overhead name plates. Built in the constructor and ticked in `animate`, like the ring.
   *
   * WORLD GEOMETRY, not widgets -- see `nameplates.ts`' header for the reference's own verdict on the
   * medium and for why a widget would hand back the whole offscreen-target saving.
   */
  public nameplates: Nameplates;
  /**
   * What the client's own Lua has the two nameplate CVars set to, or null while nothing has answered.
   *
   * A REGISTRATION, exactly the shape `pipeline/program-warm.ts#setProgramWarmer` uses and for the same
   * reason: the switch belongs to the FrameXML runtime (`Bindings.xml`'s `NAMEPLATES` binding writes
   * `nameplateShowEnemies`) and `World` must not acquire a dependency on the Lua VM to read it.
   * `WorldUiHost#start` sets it once the runtime exists. Null -- `/game` with no `?ui=lua`, or the
   * seconds before the manifest lands -- means both plates are off, which is the CVars' own default.
   */
  public nameplateConfig: (() => NameplateConfig) | null = null;

  /**
   * THE FLOATING COMBAT TEXT -- the big engine-drawn number over the unit you just hit. Built in the
   * constructor and ticked in `animate`, like the ring and the plates, and world geometry for the same
   * three reasons (`floating-text.ts`' header).
   */
  public combatText: FloatingCombatText;

  /**
   * The CLIENT'S OWN word for an outcome -- `CombatFeedbackText[key]` (`combatfeedback.lua:15-26`), which
   * resolves to the localized `GlobalStrings.lua` value. Null while nothing has answered.
   *
   * A REGISTRATION, exactly like `nameplateConfig` above and for the same reason: the words belong to the
   * client's own Lua and `World` must not acquire a dependency on the VM to read them. There is therefore
   * ONE copy of the word table in this client and it is the game's own -- the reference hardcodes the
   * shipped enUS strings only because it has no FrameXML to ask (`combat_text/law.rs:93-100`).
   * `WorldUiHost#start` sets it. Null means a word outcome floats NOTHING, which is honest: no invented
   * English goes on screen.
   */
  public combatWord: WordSource | null = null;

  /** Swings decoded since the last frame, waiting for a camera. See the `attack:swing` subscription. */
  private readonly pendingCombatText: FloaterSpawn[] = [];

  /** key -> the client's own word, once asked. There are nine keys, so this is a session's worth of calls. */
  private readonly combatWords = new Map<string, string | null>();

  /**
   * Queue one floater for the next frame, bounded.
   *
   * BOUNDED, and a self-review of the melee arm is what found the need: the queue drains in `animate`,
   * so a tab that stops receiving `requestAnimationFrame` -- backgrounded, or between world sessions --
   * keeps taking packets and appends for ever. The bound is the pass's own `MAX_FLOATERS`, because
   * anything past it would be dropped at the spawn anyway; dropping the OLDEST matches what the pass
   * does with an overflow, so the two agree instead of one silently hoarding.
   *
   * Shared by the melee arm and both spell arms so that bound cannot be re-derived differently in three
   * places -- which is exactly how the two `HitInfo` tables drifted before `combat-text.ts` took them.
   */
  private queueCombatText(unit: Unit, category: number, text: string, color?: number): void {
    if (this.pendingCombatText.length >= MAX_FLOATERS) {
      this.pendingCombatText.shift();
    }
    this.pendingCombatText.push({ unit, category, text, color });
  }

  /**
   * One outcome word, memoized. Crossing the Lua boundary per swing would be the opposite of what the
   * owner asked for on cost, and the answer cannot change within a session -- `CombatFeedbackText` is
   * built once at load from the localized globals. A MISS is cached too, so a runtime that has not
   * answered is not re-asked forever: `has` rather than a truthiness test is what makes that work.
   */
  private combatWordCached(key: string): string | null {
    if (this.combatWords.has(key)) {
      return this.combatWords.get(key) ?? null;
    }
    // Not cached while nothing can answer -- caching a null before the runtime exists would freeze every
    // word off for the session, the trap `Nameplates#levelTint` records for the difficulty ramp.
    if (this.combatWord === null) {
      return null;
    }
    const word = this.combatWord(key);
    this.combatWords.set(key, word);
    return word;
  }
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

    // THE GROUND SELECTION RING. Same reasoning as the collision overlay directly above: its vertices
    // are world-space (it is a projected decal, `world/decal.ts`), so it belongs to the scene ROOT and
    // not to any placed subtree, and it draws nothing at all until something is targeted.
    this.selectionRing = new SelectionRing(this.scene);
    // THE LEVEL-UP BURST, on the scene ROOT for the selection ring's reason directly above: its
    // position is world-space and it belongs to no placed subtree. Draws nothing until a level lands.
    this.levelUpEffect = new LevelUpEffect(this.scene);
    this.spellKitEffects = new SpellKitEffects(this.scene);
    this.spellMissiles = new SpellMissiles(this.scene);
    // `window.worldSpellFxScale(n)` -- the owner's instrument for the one question the data cannot
    // answer. Defaults to 1, so installing it changes nothing. See `spell-fx-scale.ts`.
    installSpellFxScaleKnob(() => [
      ...this.spellKitEffects.liveModels(),
      ...this.spellMissiles.liveModels(),
    ]);

    /**
     * `window.worldSpellFx()` -- WHICH GATE CLOSED, for the projectile nobody can see.
     *
     * The kit effects are visible when enlarged and the missile is not, on the same manager, material
     * and batch. Every difference between the two lanes is upstream of the renderer and used to be a
     * silent `return`; they are all counted now, and this is where they can be read. One cast answers
     * it: a non-zero `implausibleTail` means the `SMSG_SPELL_GO` decode failed its own stride check,
     * `noTargets` means the tail named nobody, `targetNotInWorld` means the aim had no position,
     * `modelless` means the visual chain named no model, `speedless` means the spell has no Speed at
     * all. `launched` non-zero with `liveMissiles` zero means they flew and expired unseen, which is a
     * different bug from never launching.
     */
    (window as unknown as Record<string, unknown>).worldSpellFx = () => {
      const player = this.player ? this.player.position : null;
      const dist = (at: number[]) => (player === null ? null : Math.round(
        Math.hypot(at[0] - player.x, at[1] - player.y, at[2] - player.z) * 100,
      ) / 100);
      return {
        // WHERE the player is, so every distance below is readable without a second call.
        player: player === null ? null
          : [Math.round(player.x * 100) / 100, Math.round(player.y * 100) / 100,
            Math.round(player.z * 100) / 100],
        missiles: { ...this.spellMissiles.stats, live: this.spellMissiles.liveCount },
        kits: { ...this.spellKitEffects.stats, live: this.spellKitEffects.liveCount },
        // THE LEAK CHECK. `armedMinusRemoved` must ALWAYS equal `kits.live` -- if it does not,
        // `remove` is being skipped. `stuck` is the diagnosis in one number: any row whose deadline
        // has passed without it being removed. `live` describes EVERY instance including
        // self-terminating ones, which the first version of this wrongly filtered out.
        kitLeak: {
          armedMinusRemoved: this.spellKitEffects.stats.armed - this.spellKitEffects.stats.removed,
          liveCount: this.spellKitEffects.liveCount,
          stuck: this.spellKitEffects.liveDetail().filter((row) => row.stuck).length,
          live: this.spellKitEffects.liveDetail(),
        },
        // THE DECIDING NUMBERS. `distFromPlayer` should be a couple of units for a hand effect and
        // under `ParticleManager.CULL_DISTANCE` (120) for anything meant to be seen at all. A large
        // number here explains the tiny dots, the rock occluding them, and an invisible projectile,
        // all three at once -- see `SpellKitEffects#liveTransforms`.
        liveKits: this.spellKitEffects.liveTransforms()
          .map((k) => ({ ...k, distFromPlayer: dist(k.at) })),
        liveMissiles: this.spellMissiles.liveTransforms()
          .map((m) => ({ ...m, distFromPlayer: dist(m.at) })),
        missileLastError: this.spellMissiles.lastError,
        kitLastError: this.spellKitEffects.lastError,
      };
    };
    this.gameObjectSparkle = new GameObjectSparkle(this.scene);
    /**
     * `window.worldGameObjects()` -- WHY A BUSH IS NOT ON SCREEN, in one call.
     *
     * This area has now cost a round to a symptom that read as "the models do not load" and was a
     * missing POSITION: every stage of the object arc worked and the node sat at NaN, which draws
     * nowhere and is indistinguishable from a model that never arrived. These are the fields that
     * separate the stages, so the next such report is one line instead of a round.
     *
     * `pos` NaN or (0,0,0) is the position path; `model: false` with a `displayId` is the DBC or the
     * fetch; `visible: false` with a model is the program warm-up; `dynamic` 0 on a quest objective is
     * the server not activating it for us, which is a quest-state answer rather than a render one.
     */
    (window as unknown as Record<string, unknown>).worldGameObjects = () => {
      const rows: unknown[] = [];
      for (const [guid, unit] of this.entities) {
        if (unit.gameObject === null) {
          continue;
        }
        const p = unit.view.position;
        rows.push({
          guid,
          entry: unit.gameObject.entry,
          displayId: unit.gameObject.displayId,
          dynamic: unit.gameObject.dynamic,
          flags: unit.gameObject.flags,
          model: !!unit.model,
          visible: unit.view.visible,
          pos: `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`,
        });
      }
      return { count: rows.length, sparkle: this.gameObjectSparkle.stats, rows: rows.slice(0, 12) };
    };
    // `window.worldRing()` -- the ring instrument: what the last projection emitted, plus the raw
    // world-space vertices the gate measures against the terrain heightmap. See `SelectionRing#vertices`.
    window['worldRing'] = () => ({
      ...this.selectionRing.stats,
      positions: this.selectionRing.vertices(),
    });

    // THE NAMEPLATES, in the scene ROOT for the same reason as the ring: they are placed in world space
    // and belong to no subtree. `updateDynamicMatrices` walks every non-static scene child, so the plate
    // subtree's world matrices are accumulated there -- which matters, because `scene.matrixWorldAutoUpdate
    // = false` means nothing else would do it and a sprite draws from `matrixWorld`.
    this.nameplates = new Nameplates(this.scene);
    window['worldNameplates'] = () => this.nameplates.report();

    // THE FLOATING COMBAT TEXT, in the scene ROOT for the plates' reason exactly.
    this.combatText = new FloatingCombatText(this.scene);
    window['combatText'] = () => this.combatText.report();

    this.game = game;
    this.session = game.session;
    this.player = this.session.player;

    // ONE COMPLETED SWING -> ONE FLOATING NUMBER OR WORD.
    //
    // Subscribed here because `ObjectHandler` is built before `World` (`network/game/handler.js:52` then
    // `:101`), so `combatHandler` exists. `attack:swing` had NO subscriber anywhere in this client until
    // now -- it was emitted and dropped, and it dropped `hitInfo` and `victimState` with it; see
    // `combat.ts#handleAttackerState`.
    //
    // **QUEUED, not spawned here.** The size law needs `camera.aspect` and the constant-screen-size factor
    // needs `camera.fov`, and a packet arrives outside the frame. Draining in `animate` is also what keeps
    // the spawn's anchor this frame's rather than one frame stale, which is the ring's and the plates'
    // own ordering rule.
    //
    // **ONLY OUR OWN DAMAGE FLOATS**, which is the reference's emitter gate and not a simplification:
    // `0x5efea0`'s ownership classes are "the active player itself, or a unit it owns", and every other
    // source -- other players, their pets, wild units fighting each other -- is suppressed at the emitter
    // (`combat_text/law.rs:122-129`). The PET leg is unreachable here (no pet feed) and is named in
    // `floating-text.ts`. Damage taken BY the player is the other medium: `ui/unit-bridge.ts` turns the
    // same event into `UNIT_COMBAT` and the client's own `CombatFeedback` draws it on the portrait.
    this.game.objectHandler.combatHandler.on(
      'attack:swing',
      (
        attacker: string, victim: string, damage: number, hitInfo: number,
        victimState: number | null,
      ) => {
        if (this.player === null || attacker !== this.player.guid) {
          return;
        }
        const unit = this.entities.get(victim);
        if (unit === undefined) {
          return;
        }
        const text = meleeText(hitInfo, victimState, damage);
        if (text === null) {
          return;
        }
        // A WORD needs the client's own table. With no runtime up there is no word, and nothing is
        // substituted -- an invented "Dodge" would be exactly the plausible-and-wrong screen the rules
        // forbid. A NUMBER needs nothing and always floats.
        const body = text.number ?? this.combatWordCached(text.wordKey ?? '');
        if (body === null || body === '') {
          return;
        }
        // BOUNDED, and self-review is what found this: the queue drains in `animate`, so a tab that
        // stops receiving `requestAnimationFrame` -- backgrounded, or between world sessions -- keeps
        // taking packets and appends for ever. The bound is the pass's own `MAX_FLOATERS`, because
        // anything past it would be dropped at the spawn anyway; dropping the OLDEST matches what the
        // pass does with an overflow, so the two agree instead of one silently hoarding.
        this.queueCombatText(unit, text.category, body);
      },
    );

    // THE SPELL HALF OF THE SAME LAW -- the owner's "От способностей урон не показывается, только от
    // автоатак". Nothing here is a new display: `spellText` is `combat-text.ts`' port of the reference's
    // OTHER emitter (`law.rs:185-201`) and it feeds the same queue, the same categories and the same
    // word table as the swing above. The reason a spell showed nothing was that no spell packet was
    // decoded; see `network/game/object/combat-log.ts`.
    //
    // **GATE A AND THE SOURCE CLASS ARE THE MELEE ARM'S, unchanged**: only damage WE deal floats, and it
    // floats over the VICTIM. Damage taken by the player is deliberately not floated here -- that is the
    // portrait indicator's medium in the real client too, and `ui/unit-bridge.ts` is where it lands.
    //
    // **THE COLOUR IS THE ONE THING THAT DIFFERS FROM MELEE**, and it is the emitter's override rather
    // than a category row: a player's spell damage is GOLD. That is what makes the owner's own reference
    // crop -- a white number and a yellow number over the same unit at once -- reproducible: the white is
    // a swing and the yellow is a spell.
    const combatLog = this.game.objectHandler.combatLogHandler;
    combatLog.on('spell:damage', (ev: SpellDamageEvent) => {
      if (this.player === null || ev.caster !== this.player.guid) {
        return;
      }
      const unit = this.entities.get(ev.target);
      if (unit === undefined) {
        return;
      }
      const text = spellText(ev.amount, ev.absorb, ev.resist, ev.crit);
      if (text === null) {
        return;
      }
      const body = text.number ?? this.combatWordCached(text.wordKey ?? '');
      if (body === null || body === '') {
        return;
      }
      // A WORD (Absorb / Resist) keeps the row's own white; only a NUMBER takes the gold override. That
      // is the reference's split -- `damage_color` is consulted on the damage path and the word twin
      // "keeps the row-default white" (`net/apply/combat_log.rs:519-521`).
      this.queueCombatText(unit, text.category, body, text.number !== null ? COLOR_SPELL_GOLD : undefined);
    });

    // THE SPELL MISS LIST -- the owner's "не видно событий типа dodge" for anything but a swing. Same
    // queue, same word table, and the words come out of the client's own `CombatFeedbackText` exactly as
    // a dodged swing's do, so the two media cannot disagree.
    combatLog.on('spell:miss', (ev: { target: string; caster: string; code: number }) => {
      if (this.player === null || ev.caster !== this.player.guid) {
        return;
      }
      const unit = this.entities.get(ev.target);
      if (unit === undefined) {
        return;
      }
      const text = spellMissText(ev.code);
      if (text === null) {
        return;
      }
      const body = this.combatWordCached(text.wordKey ?? '');
      if (body === null || body === '') {
        return;
      }
      this.queueCombatText(unit, text.category, body);
    });

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
      // CARRY THE DECODED FIELDS ACROSS BEFORE DROPPING IT, or the eviction throws away the only copy
      // of our own character's descriptor block.
      //
      // MEASURED: `world.player` had `fields` = {} (level, health, maxHealth, race, classId, gender
      // and powerType all undefined) after 30 s in a 42-entity world, while a peer `Unit` in the same
      // registry carried the complete set. So the decode was fine and the DESTINATION was wrong --
      // `UnitLevel("player")` read 0, the player frame drew empty bars, and `UnitRace`/`UnitClass`
      // answered nil because the ids never reached the object the bridge snapshots.
      //
      // The race is the one the comment above already describes: `applyUpdates` files a plain `Unit`
      // for our own guid when the server's create block beats `run()`, `applyUnitFields` decodes into
      // it, and then `run()` calls `add(this.player)` -- which evicted that unit and put an EMPTY
      // `Player` in its place. Nothing announced it because the eviction was the intended behaviour;
      // only the data loss was not.
      //
      // Existing values do NOT overwrite anything the incoming entity already knows: the incoming one
      // is the more recent object, and a field it has set is a field something has already told it
      // about. `objectType` comes across too -- a values-only update decodes its mask against it, so
      // a `Player` that reverted to the default 3 would read every later field at the wrong offset.
      for (const [key, value] of Object.entries(existing.fields)) {
        if (value !== undefined
          && (entity.fields as Record<string, unknown>)[key] === undefined) {
          (entity.fields as Record<string, unknown>)[key] = value;
        }
      }
      if (existing.objectType !== undefined) {
        entity.objectType = existing.objectType;
      }
      this.remove(existing);
      // The bridges snapshot on this, so the frames that were drawn against an empty bag repaint.
      // Fired AFTER `remove`, so a listener walking the registry cannot see both copies.
      this.emit('unit:fields', entity);
    }
    this.entities.set(entity.guid, entity);
    // ANOTHER PLAYER'S NAME. A creature is named by `SMSG_CREATURE_QUERY_RESPONSE`, which
    // `object/combat.ts` already asks for per template; a PLAYER is named only by
    // `SMSG_NAME_QUERY_RESPONSE`, and nothing ever asked -- the only `askName` callers were three chat
    // paths. That is the whole of "I don't see players name in target window and in toolbar on top of
    // the player. But I see mobs names."
    //
    // **THIS GUARD NEVER FIRED, AND THE PRIMARY ASK IS NOT HERE.** Corrected after the owner
    // reported the name still missing: `Unit#isPlayer` was assigned in exactly one place, the local
    // `Player` constructor (`classes/player.ts:14`), so it was `false` for every player the server
    // streams -- and the `entity !== this.player` half excludes the single unit where it was true.
    // The condition was therefore false for all inputs. Worse, `add` runs BEFORE the create block's
    // type and fields are decoded (`update-object/handler.ts:309-310` constructs a bare `Unit` and
    // adds it immediately), so nothing here can know a unit is a player in the first place.
    //
    // The ask now lives where the wire has just said so, at `update-object/handler.ts`'s
    // `unit.objectType = pack.obj_type`, which is also where `isPlayer` is now set from the create
    // block. This block is kept as a second door for a re-`add` of an already-typed unit; it is no
    // longer load-bearing. `askNameOnce` dedupes on both the cache and the in-flight set, so a player
    // standing in view is asked for exactly once across both doors.
    //
    // **`!entity.name` WOULD NEVER HAVE FIRED**, and self-review caught it before it shipped:
    // `Unit#name` defaults to the STRING `"<unknown>"` (`classes/unit.ts:317`), which is truthy, so a
    // falsiness test is false for every unit that has never been named -- exactly the units this is
    // for. The literal is compared instead, which is what `ui/unit-bridge.ts:60` already does when it
    // decides whether a snapshot has a real name.
    if (entity.isPlayer && entity !== this.player
        && (entity.name === '' || entity.name === '<unknown>')) {
      if (typeof this.game?.askNameOnce === 'function') {
        this.game.askNameOnce(entity.guid);
      } else {
        // LOUD, not silent: a rename on the handler would otherwise turn this feature off with no
        // symptom but a blank name, which is the report this code exists to answer.
        console.warn('World#add: game.askNameOnce is missing -- other players will have no name');
      }
    }
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
   * The mouseover/target model brighten. See `world/hover-highlight.ts` for what it is in the real
   * client and why it costs nothing per frame.
   */
  private readonly hoverHighlight = new HoverHighlight();

  /**
   * The FOCUSED entity, or null -- the body behind the `focus` unit token.
   *
   * Written only by `ui/group-bridge.ts#FocusUnit`/`ClearFocus`, because `focus` is a pure client
   * concept set from another token's SNAPSHOT and a snapshot carries no guid by design
   * (`framexml/lua/api/units.ts:11`). `world/unit-tokens.ts` reads it so a portrait can be baked for
   * `FocusFrame`; without it that portrait resolved to nothing and drew nothing.
   *
   * Plain and public rather than the getter/setter pair `hovered` has: nothing inside `World` derives
   * from a focus change -- the lighting and ring legs that make `hovered` interesting have no focus
   * counterpart -- so a setter would be ceremony.
   */
  public focus: Unit | null = null;

  /** Backing field for `hovered`. */
  private _hovered: Unit | null = null;

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

  /**
   * What the ground selection ring needs about the current target, or null when nothing is selected.
   *
   * The RADIUS is `M2#ringFootprint x the scale the body is actually DRAWN at`. `model.scale.x` rather
   * than a second call to `Unit#renderScale`: the scale field is the value `applyRenderScale` wrote and
   * `updateMatrix` baked, so reading it cannot disagree with the size on screen -- and it already folds
   * in the wire-value-vs-DBC decision that method documents. A unit whose model has not arrived reports
   * null and the ring takes its own fallback radius, which is the reference's model-less path.
   *
   * REACTION collapses to NEUTRAL while `FactionTemplate.dbc` is in flight, which is the reference's own
   * fall-through (`ring.rs:598`, `resolved.unwrap_or(Reaction::Neutral)`) and the same collapse
   * `unit-bridge.ts` already applies to the target frame's palette. The ring is yellow for a beat rather
   * than absent.
   */
  private ringTarget() {
    const unit = this.target;
    if (unit === null) {
      return null;
    }
    const model = unit.model;
    const footprint = model ? model.ringFootprint : 0;
    return {
      position: unit.position,
      reaction: this.reactionFor(unit) ?? REACTION_NEUTRAL,
      isPlayer: unit.isPlayer,
      dead: unit.dead,
      worldRadius: footprint > 0 ? footprint * (model.scale.x || 1) : null,
    };
  }

  setTarget(unit: Unit | null) {
    if (this.target === unit) {
      return;
    }
    this.target = unit;
    // The TARGET half of the model brighten. Hover and target STACK in the reference, so this is a
    // second reason and not a second highlight -- `hover-highlight.ts` folds them. The selection ring
    // is untouched and unrelated: it is a projected decal that marks the target, this lifts the
    // lighting sum of whatever is hovered OR targeted, and both are true at once on a unit that is
    // both.
    this.hoverHighlight.setTargeted(unit);
    this.game.objectHandler.combatHandler.select(unit ? unit.guid : null);
    if (unit && unit.fields.entry) {
      this.game.objectHandler.combatHandler.queryCreature(unit.fields.entry, unit.guid);
    }
    this.emit('target:change', unit);
  }

  /**
   * The unit under the pointer, or null -- the MOUSEOVER half of the model brighten.
   *
   * Driven from the world screen's existing 100 ms hover pick (`pages/game/index.tsx`), which already
   * resolves this unit for the cursor: the highlight is a second consumer of one pick, not a second
   * pick. Idempotent, so calling it on every cadence tick with the same answer costs a reference
   * compare.
   */
  setHovered(unit: Unit | null) {
    /**
     * ON THE TRANSITION ONLY, and that guard is a performance requirement rather than tidiness.
     *
     * The pick runs on a 100 ms cadence and calls this every time, so without the guard everything
     * downstream churns ten times a second whether or not the pointer moved between units -- including
     * the `mouseover` token push and the tooltip below, which would dirty the interface draw-list
     * fingerprint and hand back the 4-7.5 ms the offscreen target buys on ~92% of frames.
     */
    if (this._hovered === unit) {
      return;
    }
    this._hovered = unit;
    this.hoverHighlight.setHovered(unit);
    /**
     * The client's own `"mouseover"` token changed. `ui/unit-bridge.ts` listens and is what pushes the
     * snapshot and drives `GameTooltip:SetUnit` -- the same division `target:change` already uses, so
     * this class keeps no VM and no tooltip knowledge.
     */
    this.emit('hover:change', unit);
  }

  /**
   * The unit under the pointer, or null -- the client's own `"mouseover"` token.
   *
   * Held here rather than asked of `HoverHighlight` because it is a fact about the WORLD that two
   * consumers want: the brighten, and `world/unit-tokens.ts` resolving `"mouseover"` for a portrait.
   * The highlight owns what to DO with it, not what it is.
   */
  get hovered(): Unit | null {
    return this._hovered;
  }

  remove(entity: Unit) {
    // Before anything is released: neither the hover nor the target reason may keep a departing
    // unit's model alive, and the lift itself is not worth clearing on materials about to be
    // disposed. `setTarget(null)` below covers the UI side of losing a target; this covers the glow.
    this.hoverHighlight.forget(entity);
    if (this._hovered === entity) {
      this._hovered = null;
    }
    // A target that streams out or dies-and-decays stops being a target. Without this the UI would
    // keep painting a unit that is no longer in the scene, and `TargetFrame` would never hide.
    if (this.target === entity) {
      this.setTarget(null);
    }
    // AND THE SAME FOR THE FOCUS. `focus` is the only token whose ENTITY this class holds across
    // streaming, so a despawned focus would leave `unit-tokens.ts` resolving a body no longer in the
    // scene and the booth baking a portrait of it. The Lua-side snapshot is deliberately left alone:
    // `FocusFrame` hides itself off `UnitExists("focus")`, which is the bridge's business, and clearing
    // that from here would need a VM this class does not hold.
    if (this.focus === entity) {
      this.focus = null;
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
    // A REPLACED BODY ARRIVES UNLIT. The hovered unit is the same object across a redress or a
    // display-id change, so the highlight's own idempotence would short-circuit and the new clone --
    // with fresh materials at zero -- would stand dark under the pointer until the pointer moved.
    // Before the early return below, because that return is about the material registry and this is
    // not.
    this.hoverHighlight.refresh();

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

  /**
   * Arm a spell visual kit on a unit -- the ONE door the cast edges use.
   *
   * Here rather than on `SpellKitEffects` itself because the particle manager belongs to the MAP, and
   * the map is replaced on a worldport: a cached manager would be the previous world's. Exactly the
   * reason `LevelUpEffect#play` takes one as an argument, and the same lookup `gameObjectSparkle`
   * does per frame.
   *
   * `persistent` is the stage: true for the precast kit armed at `SMSG_SPELL_START`, false for the
   * cast release armed at `SMSG_SPELL_GO`.
   */
  /**
   * A missile arrived: play the spell's IMPACT kit on the VICTIM.
   *
   * The impact stage plays on the target rather than the caster, which is why it was unreachable until
   * `SMSG_SPELL_GO`'s hit list was decoded -- one decode bought the missile's destination and this.
   * Self-terminating, like the cast release: an impact flash is not a held state.
   */
  playImpactKit(targetGuid: string, spellId: number): void {
    const victim = this.entities.get(targetGuid);
    if (!victim) {
      return; // it left the world during the flight
    }
    const kit = spellData.impactKit(spellId);
    if (kit === null) {
      return;
    }
    this.playSpellKit(victim, spellId, kit, false);
  }

  /**
   * Launch a cast's projectiles -- the ONE door the GO edge uses, for the particle-manager reason
   * `playSpellKit` gives.
   */
  launchSpellMissiles(
    caster: Unit,
    spellId: number,
    hits: string[],
    misses: string[],
    groundAt: { x: number; y: number; z: number } | null,
  ): void {
    this.spellMissiles.launch(
      caster,
      spellId,
      hits,
      misses,
      groundAt,
      (this.map as unknown as { particleManager?: never } | null)?.particleManager ?? null,
      (guid: string) => this.entities.get(guid)?.position ?? null,
      (this.map as unknown as { ribbonManager?: never } | null)?.ribbonManager ?? null,
    );
  }

  playSpellKit(unit: Unit, spellId: number, kitId: number, persistent: boolean): void {
    this.spellKitEffects.play(
      unit,
      spellId,
      kitId,
      persistent,
      (this.map as unknown as { particleManager?: never } | null)?.particleManager ?? null,
      (this.map as unknown as { ribbonManager?: never } | null)?.ribbonManager ?? null,
    );
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
    // separated (five samples of one unchanged build spanned 7.3-15.5 ms). These sub-spans are
    // that separation, and they are deliberately EXHAUSTIVE of `animate` -- every statement below
    // sits inside exactly one of them, so `w.entities + w.ring + w.vis + w.map + w.sky + w.debug +
    // w.matrices` reconstructs `world.animate` to within the timestamp overhead. If a statement is
    // ever added outside all SEVEN, the sum stops matching the total and that is the intended tell.
    // (`w.ring` is the newest, added with the ground selection ring; the sum rule is why it got its own
    // span instead of hiding inside `w.entities`.)
    //
    // `w.vis` is separate from `w.map` on purpose: it is the only one gated on `cameraMoved`, so it
    // reads ~0 on a still frame and its true cost is invisible in any average that mixes the two.
    // That gating is also why the HUD's `chunks` row reads 0 on a still frame -- see the report.
    beginSection('w.entities');
    this.animateEntities(delta, camera, cameraMoved);
    endSection('w.entities');

    // AFTER the entity pass, so the target's `position` is this frame's and the ring cannot lag a
    // walking mob by a frame. Its own span, because a projected decal is not free and an unnamed cost
    // inside `w.entities` would be invisible -- the same argument the five spans below were separated
    // for. Note the six-span exhaustiveness note above: this is a SEVENTH, deliberately named.
    beginSection('w.ring');
    this.selectionRing.update(this.ringTarget(), camera);
    endSection('w.ring');

    // THE LEVEL-UP BURST. Inside `w.ring`'s neighbourhood rather than its own span on purpose: with
    // nothing live this is a single `length === 0` compare, and a named span for a statement that
    // costs a compare would be more expensive than the statement. The moment it has work it is one
    // `updateMatrixWorld` on one node; the particles themselves are already counted in `w.map`, which
    // is where `ParticleManager#animate` runs.
    this.levelUpEffect.update(delta * 1000);
    // THE QUEST-OBJECT GLOW. Reconciled here rather than on a field event because the falling edge
    // matters as much as the rising one -- an object that goes out of range emits nothing to listen to,
    // it simply stops being in `entities`. See the file's cost note: one field test per entity.
    /**
     * WIRED ON THE FIRST TICK, not in the constructor -- `this.game` is not assigned yet there, which a
     * red suite said immediately (`Cannot read properties of undefined (reading 'objectHandler')`). The
     * same once-per-session shape `questMarkers`' material hooks use, and for the same reason.
     */
    if (!this.sessionGuardWired) {
      this.sessionGuardWired = true;
      const handlers = this.game.objectHandler;
      this.sessionGuard.register({
        label: 'gossip',
        npc: () => handlers.gossipHandler.source,
        close: () => handlers.gossipHandler.close(),
      });
      this.sessionGuard.register({
        label: 'merchant',
        npc: () => handlers.merchantHandler.source,
        close: () => handlers.merchantHandler.close(),
      });
      this.sessionGuard.register({
        label: 'trainer',
        npc: () => handlers.trainerHandler.source,
        close: () => handlers.trainerHandler.close(),
      });
      this.sessionGuard.register({
        label: 'questgiver',
        npc: () => handlers.questHandler.source,
        close: () => handlers.questHandler.closePanels(),
      });
      this.sessionGuard.registerLoot({
        isOpen: () => handlers.lootHandler.rows.length > 0 || handlers.lootHandler.gold > 0,
        release: () => handlers.lootHandler.release(),
      });
  /**
       * `window.worldModelFade()` -- WHY A FADE IS NOT VISIBLE, in one call.
       *
       * The owner reports it not working and I am not guessing at which half. The counters separate
       * every candidate on their own:
       *
       *  - `appeared` 0 means the arrival poll never armed anything -- no unit ever had a `model` when
       *    it was looked at, which would be a wiring fault rather than a rendering one.
       *  - `appeared` high with nothing seen means the ramp runs and the SHADER is not honouring it:
       *    `fadeBlend` never reached the material, or the blend borrow was refused.
       *  - `faded` 0 with `popped` 0 means the out-of-range path never fires at all -- this server may
       *    simply never send the `OutOfRange` block, in which case a mob leaving is a DESTROY and pops
       *    by design. That would make the despawn half unreachable rather than broken, which is a
       *    completely different answer and the one I would not have guessed.
       *  - `popped` high means units are streaming out with no body to fade.
       *
       * `blended` and `dissolved` say which mechanism arrivals actually got, which is the `ownsBatches`
       * question -- a creature that shares its materials cannot be blended and gets the stipple.
       */
      (window as unknown as Record<string, unknown>).worldModelFade =
        () => this.modelFade.stats;
      (window as unknown as Record<string, unknown>).worldSessionGuard =
        () => this.sessionGuard.stats;
    }
    // The session guard: one squared-distance compare per OPEN window, nothing at all with none open.
    // The appear/despawn ramps -- one Set lookup per entity, plus a cubic per live fade.
    this.modelFade.update(this.entities, delta * 1000);
    this.sessionGuard.update(
      this.entities,
      this.player ?? null,
      this.player ? this.player.move.horizVel.lengthSq() : 0,
    );
    this.gameObjectSparkle.update(
      this.entities,
      (this.map as unknown as { particleManager?: never } | null)?.particleManager ?? null,
    );
    // The kit effects: one array-length compare with nothing live, one subtract-and-compare per live
    // instance otherwise. `ownerGone` is what releases a model handle when a unit leaves the world --
    // a bone child dies with its body but `M2Blueprint.unload` is a refcount and would never be
    // called. Same `entities` identity test `combatText.update` takes.
    this.spellKitEffects.update(
      delta * 1000,
      (guid: string) => this.entities.get(guid) === undefined,
      camera,
    );
    // The projectiles: one array-length compare with nothing in flight. `unitAt` is what makes the
    // flight HOMING -- the aim is re-resolved every frame off the live entity set.
    this.spellMissiles.update(
      delta * 1000,
      (guid: string) => this.entities.get(guid)?.position ?? null,
      (targetGuid: string, spellId: number) => this.playImpactKit(targetGuid, spellId),
      camera,
    );

    // THE NAMEPLATES, an EIGHTH named span. See the exhaustiveness note above: a statement outside all
    // of them breaks the sum rule, and that is the tell it exists for. After the entity pass for the
    // ring's reason (the plate must not lag a walking mob by a frame) and before `w.matrices`, which is
    // what accumulates the plate subtree's world transforms.
    beginSection('w.plates');
    this.nameplates.update(
      this.entities.values(),
      this.player,
      this.target,
      camera,
      this.nameplateConfig?.() ?? { showEnemies: false, showFriends: false, levelColor: null },
      // Offline has no protocol at all, and `session.offline` short-circuits ahead of the `protocol`
      // getter for the reason `world-ui.ts` states: reaching `game.objectHandler` there constructs
      // transports the offline route contracts never to touch. So an offline plate carries no name,
      // which is honest -- there is no server to have sent one.
      this.session.offline
        ? null
        : (entry, guid) => this.game.objectHandler.combatHandler.queryCreature(entry, guid),
    );
    endSection('w.plates');

    // THE FLOATING COMBAT TEXT, a NINTH named span -- see the exhaustiveness note above; a statement
    // outside all of them breaks the sum rule, which is the tell it exists for. After the plates so a
    // spawn's anchor is this frame's, and before `w.matrices`, which accumulates the sprite subtree's
    // world transforms.
    beginSection('w.ctext');
    // The scale that makes one logical (768-space) unit one logical unit on screen at any depth, the same
    // derivation `Nameplates#update` documents: with `sizeAttenuation` off three multiplies a sprite's
    // scale by the view depth.
    const textUnitScale = (2 * Math.tan((camera.fov * Math.PI) / 360)) / 768;
    for (const spawn of this.pendingCombatText) {
      this.combatText.spawn(spawn, camera.aspect, textUnitScale);
    }
    this.pendingCombatText.length = 0;
    // `gone` is asked rather than assumed: a floater outlives its victim by up to 1.5 s, and a unit that
    // died or streamed out is no longer in `entities` -- reading `position` off it would drift or snap.
    this.combatText.update(delta, (unit) => this.entities.get(unit.guid) !== unit);
    endSection('w.ctext');

    if (this.map !== null) {
      if (cameraMoved) {
        beginSection('w.vis');
        /**
         * The PLAYER's own position rides along as a fallback seed. A third-person eye is routinely
         * outside the room -- measured at ten yards horizontally and seven up from the feet, which
         * put it outside the abbey hall entirely and made the whole world resolve as OUTDOORS. See
         * `location-manager.js#locateCamera`; the eye is still tried first.
         */
        const bodySeed = this.player ? this.player.position : null;
        this.map.locateCamera(camera, bodySeed);
        this.map.updateVisibility(camera, bodySeed);
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

    // THE QUESTGIVER MARKERS, and the placement is load-bearing: AFTER `w.matrices`.
    //
    // The one-time `1/L` counter-scale reads the attach bone's WORLD matrix, and this scene has
    // `matrixWorldAutoUpdate = false` -- so before `updateDynamicMatrices` has run, that matrix is
    // still the identity it was constructed with and `L` reads ~1. Baking there is the reference's
    // documented case A: no counter-scale at all, permanently, and invisible on an unscaled unit.
    // Running here means a marker attached this frame is baked on the next one, with a real basis.
    //
    // No named span: with no statuses (offline, or before the first
    // `SMSG_QUESTGIVER_STATUS_MULTIPLE`) this is one null check, and with statuses it is a walk over
    // a handful of markers.
    /**
     * THE CONTROL ARM, in the shape `worldRingEnabled` and `worldCombatFacing` already use.
     *
     * The owner reported white helm and shoulder textures on an NPC in the same frame as a white
     * marker, and attributed it to this feature. He may well be right and I cannot settle it by
     * reading: the marker path loads a model by path and attaches it to a BONE, and this repo's own
     * rules record that an attachment shares its batches with every other copy of that path in the
     * zone -- "a SHARED material is not yours to write", three rounds spent on it already. His own log
     * shows two markers of the SAME path attached to two different NPCs in one frame (`live=2`), which
     * is exactly the shape of that hazard.
     *
     * So rather than argue: `window.worldQuestMarkersEnabled = false` and reload. If the armour comes
     * back, the markers are the cause and the fix is a per-instance model rather than a shared one. If
     * it does not, this feature is exonerated and the defect is elsewhere -- and either answer is worth
     * more than my reasoning. One property read per frame.
     */
    if (!this.questMarkerProbePublished) {
      this.questMarkerProbePublished = true;
      /**
       * THE MARKERS' MATERIALS JOIN THE MAP'S LIGHT AND FOG REGISTRY, and without this they render WHITE.
       *
       * `adoptAttachedModel` documents the mechanism for helms, pauldrons and weapons, and a marker is the
       * same kind of thing: nothing else hands an attached model's materials their fog uniforms, so
       * `fogParams` stays `(0,0,0,0)` and `fogColor` keeps its constructor default -- white -- and
       * `applyFog` then replaces the fragment with it outright at every distance.
       *
       * Wired here rather than inside `QuestMarkers` so that class keeps knowing nothing about the map,
       * and wired in the same once-per-session block as the probe because it is the same kind of one-time
       * hookup.
       */
      this.questMarkers.adoptMaterials = (model) => {
        this.adoptAttachedModel(null as never, model);
      };
      this.questMarkers.releaseMaterials = (model) => {
        this.releaseAttachedModel(null as never, model);
      };
      (window as unknown as Record<string, unknown>).worldQuestMarkers = () => ({
        feed: this.questMarkerStatuses === null ? null : this.questMarkerStatuses.size,
        live: this.questMarkers.liveCount,
        ...this.questMarkers.stats,
      });
    }

    if (
      this.questMarkerStatuses !== null
      && (window as unknown as Record<string, unknown>).worldQuestMarkersEnabled !== false
    ) {
      this.questMarkers.update(this.entities, this.questMarkerStatuses);
    }

    /**
     * THE MARKER INSTRUMENT, and its absence is why "no `!` appears" could not be diagnosed at all.
     *
     * `quest-markers.ts:152` already claimed `window.worldQuestMarkers()` read its counters and
     * **nothing registered that handle** -- so the subsystem shipped with an instrument that did not
     * exist, and a comment asserting it did. Both halves are defects by this project's own rules.
     *
     * `feed` is the first field to read and it separates two completely different failures: `null`
     * means the bridge never installed the status map, so the `update` above has never run once and
     * every counter below is zero for a reason that has nothing to do with markers, models or
     * attachment slots. A number means statuses are arriving and the counters are then meaningful --
     * `noSlot` in particular is the reference's render-nothing case, which is silent by design.
     *
     * Published ONCE, not per frame: the closure would otherwise be allocated on every tick, and this
     * is a console handle rather than a per-frame reading.
     */

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
        // `move.horizVel` DIRECTLY for the player, never `locomotionSpeed()`. That method MUTATES --
        // it advances `locoPrevX/Y` and sets `locoTracking`, which is the baseline the measured-
        // displacement leg differences against. Calling it from an instrument would make the
        // instrument change what it measures, which is the exact failure mode `CLAUDE.md` warns about
        // and which this project has already shipped once. The player's own leg returns this value.
        peerTrace.recordRender(
          entity.guid,
          entity.view.matrixWorld,
          entity.locomotionFlags(),
          entity.isPlayer ? entity.move.horizVel.length() : (entity.remoteMotion?.speed ?? 0),
          inst?.current?.id ?? -1,
          inst?.playbackRate ?? 0,
          // The TERRAIN height under the unit's OWN xy, from the heightmap rather than a cast: this is
          // the reference point the round's step-size percentiles did not have, and a heightmap lookup
          // costs 0.065 ms against a cast's 0.92 (both measured). It answers `null` for an unstreamed
          // chunk, which the row keeps distinct from "the error is zero".
          collisionWorld.terrain.heightAt(entity.view.position.x, entity.view.position.y),
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
    // THE COMBAT-FACING CONTROL ARM, read ONCE for the frame. `window.worldCombatFacing = false` gives
    // a mob back the heading its last packet left, which is the "before" the rule is measured against --
    // a fight is not reproducible across two builds, so this is the only honest A/B. Hoisted out of the
    // entity loop: inside it, the short-circuit put a `window` property read in front of every unit
    // every frame (~4800 a second in a busy zone) for a value that cannot change mid-frame.
    const combatFacing = (window as unknown as Record<string, unknown>).worldCombatFacing !== false;

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
      // WHO THIS UNIT IS FIGHTING, as a point, before it integrates. A `Unit` cannot resolve a guid --
      // it holds no registry -- so the world hands it the position and the unit owns the turn
      // (`Unit#combatFacingPoint`, and the owner's own rule quoted there). `entities` carries the local
      // player too (`run` files him at :156), so a mob fighting US resolves through the same lookup.
      //
      // CREATURES ONLY (`objectType` 3), and that scope is deliberate. The owner's rule is about a MOB;
      // a PEER PLAYER reports his own facing on the wire (`MSG_MOVE_SET_FACING` while he turns, which
      // `remoteMotion.orientation` carries), and turning him toward his victim would override what his
      // own client is showing. A creature has no such authority to override -- measured, its
      // `remoteMotion` is null, because it moves by splines.
      //
      // One `Map.get` per CREATURE actually in combat and nothing at all for the rest, which is every
      // unit in a quiet zone.
      entity.combatFacingPoint = null;
      if (combatFacing && entity.objectType === OBJECT_TYPE_CREATURE
        && entity.inCombat && entity.combatTarget !== null) {
        const foe = this.entities.get(entity.combatTarget);
        if (foe !== undefined && foe !== entity) {
          entity.combatFacingPoint = foe.view.position;
        }
      }

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

      // The MARKERS' billboards are not reachable from here: each is a separate `M2` parented to a bone
      // of one of these models, so it is in no collection this loop walks. `QuestMarkers#animate` is
      // called once per frame beside the update instead -- see its own doc.

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

    /**
     * THE MARKERS, once per frame and here rather than beside their `update`.
     *
     * Their billboards are unreachable from the loop above: each marker is a separate `M2` parented to a
     * BONE of one of the models it walks, so it is in no collection this method iterates -- which is
     * exactly why the owner's `?` never turned to face him. `camera` and `cameraMoved` are in scope only
     * here, and `animate` early-outs on a still camera and on a model with no billboarded bones, so a
     * frame with nothing to do costs one call and one boolean.
     */
    this.questMarkers.animate(camera, cameraMoved);

    endAnimSection();
  }
}
