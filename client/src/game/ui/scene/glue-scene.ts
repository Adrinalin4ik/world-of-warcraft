/**
 * The 3D glue scene: the model behind every pre-world screen.
 *
 * The mechanism is the client's own, read out of our GlueXML rather than guessed:
 *   `SetBackgroundModel` (glueparent.lua:376) -> Interface\Glues\Models\UI_<token>\UI_<token>.m2
 *   `SetSequence(0)` + `SetCamera(0)` (characterselect.lua:11, charactercreate.lua:66)
 *   `SetLighting` (glueparent.lua:327) -> CharModelFogInfo fog + RaceLights directionals
 * The character (spec 6) stands on the scene's attachment **id 0** -- the stage spot, on camera 0's
 * axis in every UI_* scene.
 *
 * Two notes that decide the code:
 *  - `SetCamera(index)` indexes the camera TABLE directly. These scenes ship one camera whose
 *    `cameraLookups` slot holds the 0xffff none sentinel, so a lookup-based selection finds nothing.
 *  - We render DIRECTLY into the canvas, first pass, with the widget layer over it. benilla bakes
 *    its glue scene to an offscreen target because one booth serves portraits, paper doll and glue
 *    alike; we have no such sharing, and a fullscreen render-to-texture would cost a target and a
 *    blit for nothing.
 */
import * as THREE from 'three';

import { worldClock } from '../../pipeline/m2/anim/world-clock';
import M2Blueprint from '../../pipeline/m2/blueprint';
import {
  applyPerObjectLighting,
  MAX_POINT_LIGHTS,
  SelectedLight,
} from '../../pipeline/m2/material/per-object-light';
import { packFogParams } from '../../world/light/fog';
import {
  foldRaceLights,
  fogTriple,
  MAIN_MENU_FOG,
  modelLightRows,
  modelToRender,
  RACE_LIGHTS,
  RaceLightRow,
  verticalFov,
} from './scene-rig';
import { CharacterLook } from './character-look';
import { cachedComposite } from './body-composite';
import { GlueScene, lightingKey, scenePath, sceneToken } from './tokens';

/**
 * `AnimationData.dbc` id 0 -- Stand. The same id `classes/unit.ts` arms a freshly loaded unit with,
 * and the id `resolve` falls back to for anything a model does not carry.
 */
const STAND_ANIMATION_ID = 0;

/** The scene's own root, so the character can yaw without the stage yawing with it. */
export class GlueSceneView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  private readonly root = new THREE.Group();

  /**
   * The character's own parent, so `yaw` turns the character and not the stage.
   *
   * `root` holds the STAGE (see `setScene`), so yawing `root` would spin the buildings with the
   * player -- which is what the class comment's "so the character can yaw without the stage yawing
   * with it" is guarding against. Two groups is what actually delivers that; one did not.
   */
  private readonly characterRoot = new THREE.Group();

  private requested: GlueScene | null = null;
  private loadedToken: string | null = null;
  private model: any = null;
  private cameraDef: any = null;
  private stage: THREE.Vector3 | null = null;
  /** The loaded character M2, or null. Posed and lit alongside the stage; see `update`/`render`. */
  private character: any = null;
  /**
   * The item M2s hanging off the character's bones -- weapons, a shield, the shoulder pair, the helm.
   *
   * Tracked separately from `character` even though they are its scene-graph descendants, because
   * `M2Blueprint.unload` is a reference-counted release against a path and the graph cannot be walked
   * for it: `dropCharacter` has to release exactly the models it loaded, once each. See `attachItems`.
   */
  private attached: any[] = [];
  /** Which `setCharacter` call the in-flight load belongs to. Monotonic, like `loadedToken`. */
  private characterToken = 0;
  private lighting: {
    probe: ReturnType<typeof foldRaceLights>['probe'];
    pointLights: SelectedLight[];
    fogColor: THREE.Color;
    fogParams: [number, number, number, number];
  } | null = null;

  yaw = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.scene.name = 'GlueScene';
    this.scene.add(this.root);
    this.characterRoot.name = 'GlueCharacter';
    this.scene.add(this.characterRoot);
    // WoW model space is Z-up.
    this.camera.up.set(0, 0, 1);
  }

  /** The character's spot, model space. Null until a scene is loaded. */
  get stageSpot(): THREE.Vector3 | null {
    return this.stage;
  }

  /**
   * Put a character on the stage, or take one off with `null`.
   *
   * WHERE it stands is the stage asset's own answer: attachment **id 0** of the `UI_<race>.m2`,
   * which every glue stage ships and which sits on camera 0's axis. Read in `setScene` and exposed
   * as `stageSpot`; this is its first reader.
   *
   * WHEN, relative to the stage, is not ordered: character select changes the stage and the
   * character on the same click (`CharacterSelect_SelectCharacter` calls `SetBackgroundModel` then
   * `SelectCharacter`, characterselect.lua:430-433), and either `.m2` may land first. So the
   * placement is re-applied in `update` from whichever pair is currently in hand rather than done
   * once here -- a character that arrives before its stage would otherwise stand at the origin for
   * the rest of the screen.
   */
  setCharacter(look: CharacterLook | null): void {
    const token = ++this.characterToken;
    this.dropCharacter();

    if (!look) {
      return;
    }

    // The model and the body composite in parallel: the composite's sources are 8 independent HTTP
    // fetches through the same worker pool the `.m2` uses, and measured they are the slow half (p50
    // 57 ms per cold source against 1.3 ms to decode one). Awaiting them in sequence would add the
    // whole fetch to the time before anything stands on the stage.
    //
    // The bake arm CANNOT be allowed to reject. `Promise.all` rejects as a whole, and this pair is
    // what owns the loaded `.m2`: a rejection would skip the handler below, so the model would never
    // be added to the scene and never be unloaded either -- a leak plus an invisible character, for a
    // texture problem. `compositeBody` already answers null for every failure it can name; this
    // catch is for the one it cannot.
    Promise.all([
      M2Blueprint.load(look.modelPath),
      cachedComposite(look.compositeKey, look.bodyLayers).catch((error) => {
        console.warn('glue character: the body composite threw; falling back to the raw skin', error);
        return null;
      }),
    ]).then(([model, composite]) => {
      // A different character (or none) was asked for while this was in flight.
      if (this.characterToken !== token) {
        M2Blueprint.unload(model);
        return;
      }

      this.character = model;
      this.characterRoot.add(model);
      // Same reason as the stage's own line: `M2` constructs itself hidden and there is no
      // visibility manager here to turn it on.
      model.visible = true;
      model.scale.setScalar(look.scale);
      // `updateMatrix()` or the scale above reaches nothing: `M2` sets `matrixAutoUpdate = false` on
      // itself (`pipeline/m2/index.ts:163`), so `updateMatrixWorld` skips `updateMatrix` and composes
      // the parent's world matrix with a `matrix` that is still the identity it was constructed with.
      // The line was written without this and was therefore inert -- every race drew at scale 1.0,
      // which is right for the ten races whose `CreatureDisplayInfo.scale` is 1.0 and wrong for exactly
      // one: Gnome male display 1563 is **1.15** (measured), and `Gfsa` on the live roster is a gnome.
      // Found while adding attachments, which need the same call for the same reason -- see
      // `M2#attachTo`.
      model.updateMatrix();

      // A character `.m2` carries every hairstyle, glove, boot and cloak at once -- 61 submeshes on
      // `humanmale00.skin` for 54 geoset ids. Without this the body wears all of them simultaneously.
      model.setVisibleGeosets(look.geosets);
      // Texture slots 1 (body), 6 (hair) and 2 (cloak), in one supply. `hairTexture` is null for a
      // bald look --
      // `CharSections` BaseSection 3 VariationIndex 0 carries empty strings and there is no hair mesh
      // to sample them, so that is the right value, not a missed assignment.
      //
      // The body slot takes the baked COMPOSITE -- a `THREE.DataTexture` this process owns, not a
      // path -- which is why `M2Material#loadTextures` takes a texture there without going through
      // `TextureLoader`. `look.bodyTexture` (the raw base skin path) is the fallback for a bake that
      // could not happen at all: no base row, a fetch that failed, or a compressed base skin. It
      // draws the blank-faced body that shipped before the compositor, which is a worse picture but
      // not a wrong one.
      const body = composite?.texture ?? look.bodyTexture;
      if (composite) {
        console.debug(
          `glue character: composited ${composite.layers} layers in ` +
            `${composite.bakeMs.toFixed(1)} ms (sources ${composite.fetchMs.toFixed(1)} ms)`,
        );
      } else if (look.bodyLayers.length > 0) {
        console.warn(
          'glue character: the body composite could not be baked; binding the raw base skin',
        );
      }
      if (body || look.hairTexture || look.capeTexture) {
        model.characterTextures = { body, hair: look.hairTexture, cape: look.capeTexture };
      }

      // The looping Stand, through `resolve` and not a raw slot: `resolve` follows the alias chain and
      // falls back to the first sequence whose keyframes are actually in the `.m2`. Measured on
      // `humanmale.m2`: 156 sequences, 104 with inline keys and 52 external (`.anim` siblings), and
      // AnimationData id 0 has four variations in slots 0, 22, 23 and 136, all inline, all flags
      // 0x20 -- so bit 0 is clear and `sequenceLoops` makes them loops. Slot 0, length 2667 ms, is
      // what `resolve(0)` lands on.
      const sequence = model.modelAnim?.resolve?.(STAND_ANIMATION_ID) ?? null;
      if (sequence && model.instanceAnim) {
        model.instanceAnim.arm(sequence, worldClock.ms);
      } else {
        console.warn(
          `glue character: ${look.modelPath} has no playable Stand sequence; it stands in bind pose`,
        );
      }

      this.placeCharacter();
      this.attachItems(model, look, token);
    });
  }

  /**
   * Hang the look's item models on the character's bones (piece 9).
   *
   * AFTER the body is in the scene and NOT in the `Promise.all` above, because every attachment's
   * destination is a bone of a model that has to exist first -- `M2#attachTo` reads the body's own
   * attachment table. So the body appears as soon as it lands and the weapon follows it a frame or
   * three later, rather than both waiting for the slowest fetch. On character select that gap is
   * invisible; it is stated here so the ordering is not mistaken for an oversight.
   *
   * Each item is loaded independently rather than through one `Promise.all`, so one 404 (a texture
   * family that ships under a name the DBC does not spell) costs its own model and not the others.
   *
   * `token` is re-checked inside every arm: an attachment fetch is exactly as cancellable as the body's
   * was, and a roster click during it would otherwise hang the previous character's sword on the new
   * character's hand -- or on nothing at all, since `this.character` has by then been replaced.
   */
  private attachItems(body: any, look: CharacterLook, token: number): void {
    for (const item of look.attachments) {
      M2Blueprint.load(item.modelPath)
        .then((model: any) => {
          if (this.characterToken !== token || this.character !== body) {
            M2Blueprint.unload(model);
            return;
          }
          if (!body.attachTo(item.attachId, model)) {
            // Not an error and not a guess: the reference's world path has the same rule -- "the body
            // has no such attach point -- hold nothing" (`attach/glue_preview.rs:325-326`). It cannot
            // fire for the six ids piece 9 uses on any playable 3.3.5a character (all six were dumped
            // out of `HumanMale.m2`), so if it ever does, the model is the news.
            console.warn(
              `glue character: ${body.name ?? 'the body'} has no attachment ${item.attachId} ` +
                `for ${item.kind} -- ${item.modelPath} draws nothing`,
            );
            M2Blueprint.unload(model);
            return;
          }
          this.attached.push(model);
          // Same reason as the body's and the stage's: `M2` constructs itself hidden and there is no
          // visibility manager on this screen.
          model.visible = true;
          // Texture type 2, the item model's only runtime slot. Null when the row names no texture,
          // which leaves the shared `PLACEHOLDER` -- a visibly flat item rather than a missing one.
          model.objectTexture = item.texturePath;
        })
        .catch((error) => {
          console.warn(`glue character: ${item.modelPath} did not load`, error);
        });
    }
  }

  /** Sit the character on `stageSpot` and turn it by `yaw`. Cheap; called per frame from `update`. */
  private placeCharacter(): void {
    if (!this.character) {
      return;
    }
    if (this.stage) {
      this.characterRoot.position.copy(this.stage);
    }
    this.characterRoot.rotation.z = this.yaw;
  }

  private dropCharacter(): void {
    // The attachments first, and off their BONES rather than off `characterRoot` -- that is where
    // `attachTo` put them, and removing the body alone would leave them parented to a disposed
    // skeleton with their reference never released.
    for (const item of this.attached) {
      item.parent?.remove(item);
      M2Blueprint.unload(item);
    }
    this.attached = [];

    if (this.character) {
      this.characterRoot.remove(this.character);
      M2Blueprint.unload(this.character);
    }
    this.character = null;
  }

  setScene(scene: GlueScene | null): void {
    this.requested = scene;

    if (!scene) {
      this.teardown();
      return;
    }

    const token = sceneToken(scene);
    if (token === this.loadedToken) {
      return;
    }

    this.teardown();
    this.loadedToken = token;

    M2Blueprint.load(scenePath(scene)).then((model) => {
      // A scene swap while this was in flight: drop the late arrival rather than stacking stages.
      if (this.loadedToken !== token) {
        M2Blueprint.unload(model);
        return;
      }

      this.model = model;
      this.root.add(model);

      // `M2` constructs itself HIDDEN (`this.visible = false`, `pipeline/m2/index.ts`) — a blueprint
      // hands back a group nobody is drawing yet, and in the world it is the visibility manager that
      // turns each placement on once culling has decided it is on screen. The glue scene has no
      // such manager and exactly one always-on-screen model, so it owns that decision itself.
      // Without this line everything else works perfectly — the model loads, arms, lights, poses,
      // and submits zero draw calls, which looks exactly like every other cause of a black screen.
      model.visible = true;

      // `SetSequence(0)` is the FILE SLOT, not an AnimationData id -- slot 0 is the stage's own
      // ambient loop.
      const sequence = model.modelAnim?.sequences?.[0];
      if (sequence && model.instanceAnim) {
        model.instanceAnim.arm(sequence, worldClock.ms);
      }

      this.cameraDef = model.data?.cameras?.[0] ?? null;
      const attachment = (model.data?.attachments ?? []).find((entry: any) => entry.id === 0);
      this.stage = attachment
        ? new THREE.Vector3(
            ...modelToRender([
              attachment.position[0],
              attachment.position[1],
              attachment.position[2],
            ]),
          )
        : new THREE.Vector3();

      this.lighting = this.buildRig(scene, model);
    });
  }

  /**
   * Fold the rig once per scene: RaceLights into the probe lane, the model's own POINT lights into
   * the point table, and the fog triple from `CharModelFogInfo` (or the login screen's authored
   * `ModelFFX` values).
   */
  private buildRig(scene: GlueScene, model: any): NonNullable<GlueSceneView['lighting']> {
    // The LOGIN screen has no Lua rig, and it does not need a placeholder either -- the MODEL's own
    // lights are the same data. `SetLighting` is reached from exactly one place,
    // `SetBackgroundModel` (glueparent.lua:385), which only character select and create call, so
    // the main menu takes the engine's DEFAULT background rig ("ResetLights() sets all 6 light sets
    // to default for the background", glueparent.lua:348) -- and glueparent.lua:50 says in so many
    // words where that default comes from: "RaceLights[] duplicates the 3.2.2 color values in the
    // models."
    //
    // That is not taken on the comment's word. Byte-checked against the shipped assets, for
    // `UI_Human.m2`'s three directionals against `RaceLights.HUMAN`'s three rows:
    //   model light 0  diffuse (0.9490197, 0.8, 0.5411765) x 1.10  = (1.043922, 0.88, 0.595294)
    //   RaceLights [3] diffuse (0.5219608, 0.44, 0.2976471) x 2.00 = (1.043922, 0.88, 0.595294)
    //   model light 1  diffuse (0.3058824, 0.5372549, 0.6705883) x 0.65 = (0.198824, 0.349216, 0.435882)
    //   RaceLights [2] diffuse (0.1988235, 0.3492157, 0.4358824) x 1.00 = (0.198824, 0.349216, 0.435882)
    //   model light 2  ambient (1, 1, 1) x 0.27 = RaceLights [1] ambient (0.27, 0.27, 0.27) x 1.0
    // Identical to every digit the files carry. So for a scene with no Lua row the model's own
    // directionals are not an approximation of the rig, they ARE the rig, and the same fallback is
    // right for a token the table does not name (DRAENEI and BLOODELF have light rows but no fog
    // row; a future stage might have neither).
    //
    // WHAT THIS DOES NOT FIX, so nobody re-investigates it: the login screen's flat cyan SKY is not
    // a lighting problem and no rig can touch it. Measured -- drop the main menu's ambient to 0.02
    // and every surface in the frame goes black (bridge 10,24,29 -> 1,1,1; snow 162,212,239 ->
    // 3,4,5) while the sky does not move by one 8-bit step, because it is `LOGIN_SKYBOWLA.BLP`
    // (sampled rgb 43,201,216, which is exactly the texture's own flat region) drawn by materials
    // the M2 flags 0x13 = UNLIT | UNFOGGED | no-depth-write. The engine could not darken it either.
    // What our sky is missing against the real screen is the CLOUD layers over that bowl
    // (`ICECROWN_CLOUDSA*`, `LOGIN_CLOUDS_UNHOLY01`, `ICECROWN_GLOW*`, `ICECROWN_LIGHTRAY_01`) --
    // their meshes are built and visible (70 of 71 are), so it is a blend/draw-order question in the
    // M2 pipeline, not a glue-scene one.
    const key = lightingKey(scene);
    const rows = pickLightRows(key, model);
    const { probe } = foldRaceLights(rows);

    const pointLights: SelectedLight[] = [];
    for (const light of model.data?.lights ?? []) {
      if (light.type !== 1) {
        continue; // a directional: it belongs to `rows` above, not to the point table
      }
      if (light.visibility?.firstKeyframe?.value === 0) {
        continue; // a light the asset ships explicitly dark
      }
      const color = light.diffuseColor?.firstKeyframe?.value ?? [1, 1, 1];
      const intensity = light.diffuseIntensity?.firstKeyframe?.value ?? 1;
      pointLights.push({
        // Model space like the camera, so the same conversion applies -- a point light left in raw
        // coordinates lights the mirror image of the spot the artist placed it at.
        position: modelToRender([light.position[0], light.position[1], light.position[2]]),
        color: [color[0] * intensity, color[1] * intensity, color[2] * intensity],
        attenStart: light.attenuationStart?.firstKeyframe?.value ?? 0,
        attenEnd: light.attenuationEnd?.firstKeyframe?.value ?? 0,
      });
      if (pointLights.length >= MAX_POINT_LIGHTS) {
        break;
      }
    }

    if (scene.kind === 'mainmenu') {
      return {
        probe,
        pointLights,
        fogColor: new THREE.Color(MAIN_MENU_FOG.r, MAIN_MENU_FOG.g, MAIN_MENU_FOG.b),
        fogParams: packFogParams(MAIN_MENU_FOG.near, MAIN_MENU_FOG.far),
      };
    }

    const fog = fogTriple(key ?? '');
    return {
      probe,
      pointLights,
      fogColor: fog ? new THREE.Color(fog.color[0], fog.color[1], fog.color[2]) : new THREE.Color(0, 0, 0),
      // No row means ClearFog(): push the fog band past the far plane instead of branching in the
      // shader.
      fogParams: fog ? fog.params : packFogParams(0, 100000),
    };
  }

  update(dt: number): void {
    // Read the clock ONCE and reuse it for both channels below, so bone and material sampling
    // cannot land on two different instants within the same frame.
    const clock = worldClock.ms;

    // Before the stage gate, so the character's own clock does not depend on the stage's arrival.
    // `render` still draws nothing until the stage is in (it needs the stage's rig and camera), but
    // `InstanceAnim` is clock-INDEXED off `armedAtMs` rather than accumulated, so a character solved
    // from the moment it is armed enters its first drawn frame at the phase the clock says -- not at
    // keyframe zero, and not one solve behind.
    if (this.character) {
      // The attachments BEFORE the body's `updateMatrixWorld`, so one recursive walk covers both --
      // they are its scene-graph descendants (bone children), so the body's walk reaches them and a
      // second `updateMatrixWorld` per item would be duplicated work.
      //
      // POSED BUT NEVER ARMED, deliberately. `solveBones` on an unarmed instance reads sequence slot
      // -1, every channel falls through to bind pose (`instance-anim.ts:223-228`), and bind pose is
      // exactly what an attached item should show: the reference calls it "a static mesh: its origin
      // *is* the grip, aligned by the attach bone's animated frame"
      // (`equipment/mod.rs:17-18`). What the call still buys is `evaluateMaterialChannels`, so a UV or
      // transparency track on an item's material is read from its own state rather than left at
      // whatever the shared material last held. Cheap: 8 bones on the claymore, 1 on the shield,
      // pauldrons and helm, against the body's 138.
      for (const item of this.attached) {
        this.poseModel(item, clock);
      }
      this.poseModel(this.character, clock);
      this.placeCharacter();
      this.character.updateMatrixWorld(true);
    }

    if (!this.model) {
      return;
    }

    this.poseModel(this.model, clock);
    this.model.updateMatrixWorld(true);

    this.aimCamera();
  }

  /**
   * Advance one model's animation channels and write the solved pose into its bones.
   *
   * Shared by the stage and the character because the law is the same for both, and the law is the
   * point:
   *
   * `applyPose()` only copies `instanceAnim.localTRS` into the three.js bone hierarchy -- it samples
   * nothing. `localTRS` is zero-filled at buffer allocation and written ONLY by `solveBones`, so
   * without that call every bone would sit at its bind-pose offset forever regardless of how far the
   * clock has moved. This is deliberately NOT `poseGatedInstance` (`pose-gate.ts`): that gate applies
   * distance decimation and a bone budget, both world-population concerns for throttling many
   * doodads/units against a moving camera. The glue scene is one fullscreen stage plus at most one
   * character, neither of which may be decimated and neither of which has a meaningful "distance from
   * camera" in the world-population sense, so both solve and apply unconditionally instead of going
   * through the gate built for a population they are not part of.
   *
   * It also does NOT feed `animCounters`: that singleton is a per-frame perf readout reset once per
   * frame by `World#animate` (see `counters.ts`), which never runs while a glue screen is up -- an
   * increment here would accumulate forever unreset instead of reporting a per-frame figure,
   * polluting the very HUD it exists to keep honest.
   */
  private poseModel(model: any, clock: number): void {
    if (!model.instanceAnim) {
      return;
    }
    model.evaluateMaterialChannels(clock);
    model.instanceAnim.solveBones(clock);
    model.applyPose();
  }

  /** Camera 0 owns the framing while a scene is up. */
  private aimCamera(): void {
    const def = this.cameraDef;
    if (!def) {
      return;
    }

    // Camera tracks store M2SplineKey<T> triples (`{ value, inTan, outTan }`), not bare values --
    // `firstKeyframe` hands back that wrapper untouched (`m2/animation-block.js#firstKeyframe`,
    // pinned by `m2/__tests__/camera.test.js`). Indexing the wrapper directly (`key[0]`) reads
    // `undefined` off a struct and NaNs the whole frame the moment a real model supplies a key --
    // reach through `.value` for the actual vector/float.
    const posKey = def.positions?.firstKeyframe?.value;
    const targetKey = def.targetPositions?.firstKeyframe?.value;
    const rollKey = def.roll?.firstKeyframe?.value;
    const base = def.positionBase;
    const targetBase = def.targetBase;

    // Model space, then converted: `createGeometry` bakes a 180-degree yaw about Z into every
    // vertex, so a camera aimed with raw file values points half a turn away from its own stage
    // (`modelToRender`). This is what drew an almost empty frame for UI_MainMenu and the inside of a
    // mesh for UI_MainMenu_Northrend.
    const eye = new THREE.Vector3(
      ...modelToRender([
        base[0] + (posKey ? posKey.value[0] : 0),
        base[1] + (posKey ? posKey.value[1] : 0),
        base[2] + (posKey ? posKey.value[2] : 0),
      ]),
    );
    const target = new THREE.Vector3(
      ...modelToRender([
        targetBase[0] + (targetKey ? targetKey.value[0] : 0),
        targetBase[1] + (targetKey ? targetKey.value[1] : 0),
        targetBase[2] + (targetKey ? targetKey.value[2] : 0),
      ]),
    );

    // Up = the authored roll rotated about the view axis. Same law as benilla's
    // `Quat::from_axis_angle(fwd, cam.roll) * Vec3::Y` (`portrait/framing.rs`), with Z standing in
    // for Y because our scene is Z-up, not Bevy's Y-up. When roll is unkeyed (or zero, as benilla's
    // own audit found on every portrait camera it checked) this is the identity rotation and up
    // stays the static (0, 0, 1) it always was.
    const roll = rollKey ? rollKey.value : 0;
    const forward = target.clone().sub(eye);
    const up = new THREE.Vector3(0, 0, 1);
    // A degenerate eye===target camera has no view axis to roll about; leave up static rather than
    // feed `applyAxisAngle` a zero-length axis (a non-unit quaternion for any roll !== 0).
    if (roll !== 0 && forward.lengthSq() > 0) {
      up.applyAxisAngle(forward.normalize(), roll);
    }
    this.camera.up.copy(up);

    this.camera.position.copy(eye);
    this.camera.lookAt(target);

    const size = this.renderer.getSize(new THREE.Vector2());
    const aspect = size.x / Math.max(size.y, 1);
    this.camera.aspect = aspect;
    this.camera.fov = THREE.MathUtils.radToDeg(verticalFov(def.fov, aspect));
    this.camera.near = Math.max(def.nearClip, 0.05);
    this.camera.far = def.farClip;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    if (!this.model || !this.lighting) {
      return;
    }

    // The rig is per-scene, but M2 materials are shared across instances, so it has to be pushed
    // for THIS draw -- `applyPerObjectLighting` sets `uniformsNeedUpdate` for exactly that reason.
    //
    // Traverses the SCENE, not `this.model`: the character is a sibling group (`characterRoot`), so a
    // walk of the stage model alone would never reach it. M2 materials are shared, and a material
    // nothing pushes a rig into keeps the uniform DEFAULTS declared in `material/index.ts` -- which
    // for the probe and sun lanes are zero. Untested, because the character was never drawn without
    // this line; the reason it is written this way is that no other population has run by the time a
    // glue screen is up, so there is nothing else that could have left a usable rig in those
    // uniforms.
    this.scene.traverse((node: any) => {
      const material = node.material;
      if (!material?.uniforms) {
        return;
      }
      applyPerObjectLighting(material, {
        interior: true, // the probe lane: this stage is lit by its rig, not by the world sun
        interiorFog: false,
        sunIntensity: 1,
        probe: this.lighting!.probe,
        pointLights: this.lighting!.pointLights,
      });
      material.uniforms.fogColor.value.copy(this.lighting!.fogColor);
      material.uniforms.fogParams.value.fromArray(this.lighting!.fogParams);
    });

    this.renderer.render(this.scene, this.camera);
  }

  private teardown(): void {
    // The character belongs to the ROSTER, not to the stage, and a stage swap on the same screen is
    // exactly a race click -- so it is dropped here rather than kept: the next `setCharacter` is
    // already on its way from the same Lua call that changed the stage, and keeping the old body
    // standing would show the previous character on the new race's stage until it lands.
    this.characterToken += 1;
    this.dropCharacter();

    if (this.model) {
      this.root.remove(this.model);
      M2Blueprint.unload(this.model);
    }
    this.model = null;
    this.cameraDef = null;
    this.stage = null;
    this.lighting = null;
    this.loadedToken = null;
  }

  dispose(): void {
    this.teardown();
  }
}

/**
 * The directional rig for a scene: the client's Lua row if it has one, the model's own directionals
 * if it does not (see `buildRig` for why those are the same data), and only then a placeholder.
 *
 * The placeholder is the LAST resort and it is still a placeholder: a flat white ambient, for a
 * scene that is named by no Lua table AND ships no directional light of its own. Nothing in this
 * client reaches it today -- `UI_MainMenu_Northrend` ships one -- and it exists so that such an
 * asset draws visibly-wrong rather than black, with a console line saying which scene did it.
 */
function pickLightRows(key: string | null, model: any): RaceLightRow[] {
  const fromLua = key === null ? undefined : RACE_LIGHTS[key];
  if (fromLua) {
    return fromLua;
  }
  const fromModel = modelLightRows(model?.data?.lights ?? []);
  if (fromModel.length > 0) {
    return fromModel;
  }
  console.warn(
    `glue scene: no RaceLights row for "${key ?? 'mainmenu'}" and the model ships no directional ` +
      'light -- falling back to a flat white ambient, which is a placeholder, not the rig',
  );
  return [[1, 0, 0, 0, -1, 1.0, 1.0, 1.0, 1.0, 0.0, 0, 0, 0]];
}
