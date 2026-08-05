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
  RACE_LIGHTS,
  verticalFov,
} from './scene-rig';
import { GlueScene, raceKey, scenePath, sceneToken } from './tokens';

/** The scene's own root, so the character can yaw without the stage yawing with it. */
export class GlueSceneView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  private readonly root = new THREE.Group();

  private requested: GlueScene | null = null;
  private loadedToken: string | null = null;
  private model: any = null;
  private cameraDef: any = null;
  private stage: THREE.Vector3 | null = null;
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
    // WoW model space is Z-up.
    this.camera.up.set(0, 0, 1);
  }

  /** The character's spot, model space. Null until a scene is loaded (spec 6 consumes it). */
  get stageSpot(): THREE.Vector3 | null {
    return this.stage;
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

      // `SetSequence(0)` is the FILE SLOT, not an AnimationData id -- slot 0 is the stage's own
      // ambient loop.
      const sequence = model.modelAnim?.sequences?.[0];
      if (sequence && model.instanceAnim) {
        model.instanceAnim.arm(sequence, worldClock.ms);
      }

      this.cameraDef = model.data?.cameras?.[0] ?? null;
      const attachment = (model.data?.attachments ?? []).find((entry: any) => entry.id === 0);
      this.stage = attachment
        ? new THREE.Vector3(attachment.position[0], attachment.position[1], attachment.position[2])
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
    const key = scene.kind === 'mainmenu' ? 'CHARACTERSELECT' : raceKey(scene.race);
    const rows = RACE_LIGHTS[key] ?? RACE_LIGHTS.HUMAN;
    const { probe } = foldRaceLights(rows);

    const pointLights: SelectedLight[] = [];
    for (const light of model.data?.lights ?? []) {
      if (light.type !== 1) {
        continue; // directional: our build takes those from the Lua table, not the model
      }
      if (light.visibility?.firstKeyframe?.value === 0) {
        continue; // a light the asset ships explicitly dark
      }
      const color = light.diffuseColor?.firstKeyframe?.value ?? [1, 1, 1];
      const intensity = light.diffuseIntensity?.firstKeyframe?.value ?? 1;
      pointLights.push({
        position: [light.position[0], light.position[1], light.position[2]],
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

    const fog = fogTriple(key);
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
    if (!this.model) {
      return;
    }

    // Read the clock ONCE and reuse it for both channels below, so bone and material sampling
    // cannot land on two different instants within the same frame.
    const clock = worldClock.ms;

    if (this.model.instanceAnim) {
      this.model.evaluateMaterialChannels(clock);
      // `applyPose()` only copies `instanceAnim.localTRS` into the three.js bone hierarchy -- it
      // samples nothing. `localTRS` is zero-filled at buffer allocation and written ONLY by
      // `solveBones`, so without this call every bone would sit at its bind-pose offset forever
      // regardless of how far the clock has moved. This is deliberately NOT `poseGatedInstance`
      // (`pose-gate.ts`): that gate applies distance decimation and a bone budget, both
      // world-population concerns for throttling many doodads/units against a moving camera. The
      // glue scene is exactly one fullscreen model that must never be decimated and has no
      // meaningful "distance from camera" in the world-population sense, so it solves and applies
      // unconditionally instead of going through the gate built for a population it isn't part of.
      // It also does NOT feed `animCounters`: that singleton is a per-frame perf readout reset once
      // per frame by `World#animate` (see `counters.ts`), which never runs while a glue screen is
      // up -- an increment here would accumulate forever unreset instead of reporting a per-frame
      // figure, polluting the very HUD it exists to keep honest.
      this.model.instanceAnim.solveBones(clock);
      this.model.applyPose();
    }
    this.model.updateMatrixWorld(true);

    this.aimCamera();
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

    const eye = new THREE.Vector3(
      base[0] + (posKey ? posKey.value[0] : 0),
      base[1] + (posKey ? posKey.value[1] : 0),
      base[2] + (posKey ? posKey.value[2] : 0),
    );
    const target = new THREE.Vector3(
      targetBase[0] + (targetKey ? targetKey.value[0] : 0),
      targetBase[1] + (targetKey ? targetKey.value[1] : 0),
      targetBase[2] + (targetKey ? targetKey.value[2] : 0),
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
    this.model.traverse((node: any) => {
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
