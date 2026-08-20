/**
 * THE MODEL BOOTH: a `<PlayerModel>` pane's 3D content, rendered into a texture the widget layer
 * draws like any other sprite.
 *
 * This is the subsystem `STATE.md` recorded as absent -- "PORTRAITS ARE A SUBSYSTEM, not a missing
 * global ... this repo has exactly two `WebGLRenderTarget`s, `world-ui.ts`'s interface target and
 * `scene/body-composite.ts`, which is a texture-space composite, not a scene render. There is no
 * model-to-texture path to reuse." There is now, and it serves the paper doll first because that is
 * what the owner asked for; the unit-frame portraits are the same subsystem with a different framing
 * and a round mask.
 *
 * The name is the reference's own: benilla calls it a "photo booth"
 * (`samples/benilla/crates/benilla/src/portrait/mod.rs:9-19`), and its `PAPERDOLL_SLOT` is exactly
 * this -- "a full-body bake of the dressed player, sampled square (not circular) by the character
 * frame's model pane ... its own booth: separate resolution, body framing, and a live yaw".
 *
 * ## How a model reaches a texture
 *
 * One `Pane` per model frame, each owning a `WebGLRenderTarget`, a `THREE.Scene`, a
 * `PerspectiveCamera` and one dressed M2 instance. The bake renders the scene into the target; the
 * target's texture is then ADOPTED into the UI art table under a private key
 * (`art.ts#adopt`) and the frame's `sprite` is set to that key. From there the pane is an ordinary
 * quad in the ordinary draw list, at its real draw layer -- under the tooltips, over the panel art.
 *
 * That is deliberately NOT the arrangement the cooldown sweeps and the dragged cursor icon use. Those
 * are drawn straight into the canvas AFTER the interface composite, because they move every frame and
 * a moving widget would change `drawListSignature` on every frame and force a full ~4-12 ms interface
 * re-render for as long as it moved (`world-ui.ts#drawCursorIcon`). A pane does not move: see the
 * redraw policy below. So it can afford to be a real sprite, and being a real sprite is what gets the
 * z-order right -- a late pass over the composite would put the figure on top of any tooltip that
 * overlapped it.
 *
 * ## The redraw policy, and its whole budget argument
 *
 * A pane is baked ONLY when one of four things is true:
 *
 *  1. the frame's rig `revision` moved -- a `SetUnit`, a `RefreshUnit`, or a `SetRotation`;
 *  2. the unit was redressed (`Unit#characterLook` is a new object);
 *  3. the model, its textures or one of its attachments has just landed;
 *  4. the interface was going to be fully re-rendered on this frame anyway.
 *
 * (4) is the safety valve, and it is free by construction: `world-ui.ts` already forces a full
 * interface draw one frame in twelve (`FULL_DRAW_EVERY`) precisely because a texture that arrives
 * late changes no field the fingerprint reads. Baking on exactly those frames adds a small scene
 * render to a frame that was already paying for a full pass, and adds ZERO dirty frames.
 *
 * Everything else is a hard no. Nothing here is baked per frame, and nothing is animated: the figure
 * is frozen at the Stand pose the clock read when it was last baked. That is the reference's own
 * behaviour and it is not a shortcut -- the real client "renders a unit's model once into a tiny
 * (64 squared) off-screen texture and freezes it (re-baked only on model change)"
 * (`benilla/.../portrait/mod.rs:4-6`), and benilla's own body pane bakes a "fresh throwaway instance
 * ... armed to the model's Stand and frozen, never the unit's live world pose" (`mod.rs:43-48`).
 * `CharacterModelFrame`'s own `<OnUpdate>` is `Model_OnUpdate`, which does nothing but sweep the yaw
 * while a rotate button is held (`uiparent.lua:2847-2865`) -- it never calls `AdvanceTime`. So a
 * breathing idle in the pane is a thing the client's own Lua does not ask for.
 *
 * The measured consequence is in the task report: with the character panel open, `dirtyFrames` is the
 * same one-in-twelve floor with the pane present as without it, and a bake costs one small scene
 * render on those frames only.
 *
 * ## What is reused rather than rebuilt
 *
 * The DRESSING is `character/dress.ts` -- `loadCharacter`, `applyCharacterLook`, `armStand`,
 * `attachCharacterItems` -- the same four calls the glue stage and the world's own avatar make. In
 * particular the 512x512 body composite is NOT baked again: `loadCharacter` goes through
 * `cachedComposite(look.compositeKey, ...)`, and the look handed in here is the very object the
 * world's `Unit` is wearing (`classes/unit.ts#characterLook`), so the key hits. The M2 itself is a
 * second clone of an already-parsed model (`M2Blueprint` caches per path), and a character clone
 * rebuilds its own batches and materials -- which is what makes it safe to push booth lighting into
 * them without relighting the body standing in the world.
 *
 * The LIGHT is the reference widget's own, not a studio invention: benilla's `model_pane_light_rows`
 * (`benilla/.../portrait/light.rs:154-196`) reads it out of the client binary --
 * `CharacterModelBase`'s constructor configures one directional light, to-light direction (0, 1, 0),
 * diffuse (0.8, 0.8, 0.64), ambient (0.7, 0.7, 0.7), and it is the widget's only light. Those are
 * 1.12 addresses; the values are taken because the widget class is the same one and because the
 * alternative is a number of ours with no source at all. Folded through this client's own
 * `foldRaceLights`, which wants the direction the light SHINES, so the to-light vector goes in
 * negated -- exactly the correction benilla's own packer makes at `light.rs:181-183`.
 *
 * ## What is NOT here
 *
 * Panes are never reaped. The set is bounded by the number of model frames FrameXML authors (six:
 * the paper doll, the pet and companion panes, the dress-up frame, the tabard frame and the pet
 * stable), only a pane that has actually been shown allocates anything, and each holds one M2 clone
 * plus one target of at most 512 squared. A reaper would trade that ceiling for a re-fetch every time
 * the character panel is closed and reopened, which is the worse deal.
 */
import * as THREE from 'three';

import { worldClock } from '../../pipeline/m2/anim/world-clock';
import M2Blueprint from '../../pipeline/m2/blueprint';
import { applyPerObjectLighting } from '../../pipeline/m2/material/per-object-light';
import {
  applyCharacterLook,
  armStand,
  attachCharacterItems,
  loadCharacter,
} from '../../character/dress';
import type { CharacterLook } from './character-look';
import { BodyAnchors, BustCamera, bodyFrame, portraitFrame } from './booth-framing';
import { foldRaceLights, modelToRender, RaceLightRow, rigFog } from './scene-rig';
import type { DrawItem } from '../widget';
import type { GlueArt } from '../art';

/**
 * The pane light, as one `AddLight` row.
 *
 * `[enabled, slot, dx, dy, dz, ambientIntensity, ar, ag, ab, diffuseIntensity, dr, dg, db]` --
 * `scene-rig.ts#RaceLightRow`. The colours and the direction are `CharacterModelBase`'s constructor
 * (see the file header); the two INTENSITIES are 1.0 because that constructor sets colours and no
 * intensity dial at all -- benilla says as much for its own row 19 ("no x2.5 exterior-intensity node
 * on this path", `light.rs:169-170`), so an intensity of anything but 1 would be ours and unsourced.
 *
 * The direction is the to-light vector (0, 1, 0) NEGATED: `foldRaceLights` documents that its `[2..4]`
 * is the direction the light shines, and benilla negates the same vector for the same reason
 * (`light.rs:181-183`).
 */
const PANE_LIGHT: RaceLightRow = [
  1, 0,
  0, -1, 0,
  1,
  0.7, 0.7, 0.7,
  1,
  0.8, 0.8, 0.64,
];

/**
 * The ROUND PORTRAITS' light, which is deliberately NOT the pane light above.
 *
 * benilla keeps two, and states why: "they are not the same law, because their references aren't. The
 * round unit-frame portraits ... the reference bakes those through its own portrait render
 * (`SetPortraitTexture`), not through a UI model widget, so this stays our fixed neutral front-lit
 * studio ... the body panes ... transcribe a `<PlayerModel>` widget, and the reference gives every one
 * of those exactly one light, from its own constructor" (`portrait/light.rs:74-81`). Using the pane's
 * side light on a portrait is what its own comment predicts: "everything the pane actually shows the
 * viewer is therefore lit by ambient alone" (`light.rs:172-176`) -- a face in a 64-pixel ring lit only
 * by 0.7 grey.
 *
 * The values are `studio_light_rows` (`light.rs:209-218`): ambient (0.58, 0.56, 0.54), diffuse
 * (0.85, 0.82, 0.78), and a direction from the camera's three-quarter side INTO the scene. benilla
 * carries that direction in Bevy space as (0.25, -0.45, 0.85); converted through its own mapping
 * (`wow_to_bevy([0,1,0]) = (-1,0,0)`, i.e. bevy = (-y, z, -x), so wow = (-z, -x, y)) it is
 * (-0.85, -0.25, -0.45) in model space -- travelling from the figure's front, which is where the
 * portrait camera stands. THESE ARE THE REFERENCE'S OWN NUMBERS AND NOT THE CLIENT'S: benilla says so
 * ("our fixed neutral front-lit studio ... the director-approved look"), and the real client's portrait
 * light is not on its RE record.
 */
const PORTRAIT_LIGHT: RaceLightRow = [
  1, 0,
  -0.85, -0.25, -0.45,
  1,
  0.58, 0.56, 0.54,
  1,
  0.85, 0.82, 0.78,
];

/**
 * The largest edge a pane's target may have, in device pixels.
 *
 * benilla's own `PAPERDOLL_SIZE` (`portrait/mod.rs:152`). The paper doll's pane is 233x215 logical
 * units, so at this client's usual scales the cap is not reached and the target is 1:1 with the quad
 * it draws into -- which is what keeps the figure from being resampled twice.
 */
const MAX_PANE_PIXELS = 512;

/** The pane's own art key, so two panes cannot collide in the art table. */
function paneKey(widgetId: string): string {
  return `__modelbooth:${widgetId}`;
}

/**
 * The V-FLIPPED whole-texture rect.
 *
 * A `WebGLRenderTarget`'s texture has `v = 0` at the BOTTOM (it is a framebuffer, not an uploaded
 * image), while this renderer's convention is `v = 0` at the TOP -- every texture loads
 * `flipY = false` and `renderer.ts#writeQuadUVs` builds its UVs on that basis. So the pane samples
 * the target upside down, and it is corrected HERE rather than by negating something on the texture:
 * `flipY` does not apply to a render target at all, and `repeat.y = -1` would be a per-texture
 * mutation on an object the draw pass shares. A reversed sub-rect is a first-class thing in this
 * renderer -- the client's own `CharacterSelectRotateLeft` mirrors a sheet with
 * `<TexCoords left="1.0" right="0" .../>` and nothing normalises it (`renderer.ts#writeQuadUVs`).
 *
 * The two orientation defects this project has already paid for both came from flipping in the wrong
 * layer, so the choice is recorded: the camera stays upright and honest (Z-up, the same convention
 * `glue-scene.ts` uses), and exactly one V flip happens, in the sampling rect.
 */
const FLIP_V = { u0: 0, v0: 1, u1: 1, v1: 0 };

/**
 * The direction a character faces, in RENDER space.
 *
 * A character `.m2` faces model +x -- measured, see `booth-framing.ts#BodyAnchors.front` -- and
 * `modelToRender` is a flat 180-degree yaw about Z, so forward comes out as -x. Written as the
 * conversion rather than as the literal `[-1, 0]` so that the day the geometry pipeline's baked
 * rotation changes, this changes with it: `scene-rig.ts`'s own test pins `modelToRender` against that
 * pipeline's matrix chain.
 */
const RENDER_FORWARD: readonly [number, number] = (() => {
  const forward = modelToRender([1, 0, 0]);
  return [forward[0], forward[1]];
})();

/** One model frame's booth. */
class Pane {
  private readonly scene = new THREE.Scene();

  /**
   * The figure's own parent, so `SetRotation` turns the figure and not the camera.
   *
   * The same two-group split `glue-scene.ts` makes, minus the stage: the model sits at this group's
   * origin and the group's `rotation.z` is the yaw.
   */
  private readonly root = new THREE.Group();

  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);

  private target: THREE.WebGLRenderTarget | null = null;

  private width = 0;

  private height = 0;

  private model: any = null;

  private attached: any[] = [];

  /** The subject key the current model was built from -- see `BoothSubject.key`. */
  private builtKey: unknown = undefined;

  /** Which `build` the in-flight load belongs to. Monotonic, like the glue scene's. */
  private token = 0;

  private revision = -1;

  private rotation = 0;

  private framing: 'body' | 'portrait' = 'body';

  private dirty = true;

  /**
   * The target holds a cleared frame and there is nothing to put in it.
   *
   * A pane with no body -- `TargetFramePortrait` with nothing targeted, the pet pane, a portrait whose
   * unit this client does not track -- would otherwise be cleared and re-rendered on every safety-valve
   * frame for ever. MEASURED before this latch: with the player frame hidden and nothing targeted,
   * `paneBakes` still climbed to 22 in 286 frames, all of them a clear of an empty scene. Cheap
   * (0.7 ms per bake) but a cost with nothing to show, which is the shape this whole subsystem exists
   * to avoid.
   */
  private blank = false;

  /** Cached so a bake does not re-walk the M2's tables for numbers that cannot change. */
  private anchors: BodyAnchors | null = null;

  private scale = 1;

  private readonly paneLighting = foldRaceLights([PANE_LIGHT]);

  private readonly portraitLighting = foldRaceLights([PORTRAIT_LIGHT]);

  constructor(readonly widgetId: string) {
    this.scene.name = `ModelBooth:${widgetId}`;
    this.scene.add(this.root);
    // WoW model space is Z-up -- `glue-scene.ts`'s constructor makes the same call for the same
    // reason. A Y-up camera here is one half of the pair of cancelling mistakes that put a loading
    // screen upside down.
    this.camera.up.set(0, 0, 1);
  }

  get texture(): THREE.Texture | null {
    return this.target?.texture ?? null;
  }

  /**
   * The pane's own model, for `window.worldUiBooth`.
   *
   * A read handle and nothing else. It exists because "the figure in the pane is missing a geoset" has
   * no other answer: the pane's scene is not the world scene, so nothing a probe can traverse reaches
   * it, and a screenshot of a 64-pixel head cannot tell a hidden submesh from an untextured one. This
   * is the same argument `world-ui.ts` makes for `worldUiArt` and `worldUiDrawList`.
   */
  get modelForDebug(): unknown {
    return this.model;
  }

  /**
   * Take the frame's current state. Cheap, and called every frame the pane is on screen.
   *
   * Returns nothing: whether a bake is due is `dirty`, and `bake` reads it.
   */
  request(subject: BoothSubject | null, revision: number, rotation: number,
    framing: 'body' | 'portrait', widthPx: number, heightPx: number): void {
    if (framing !== this.framing) {
      this.framing = framing;
      this.dirty = true;
    }
    if (revision !== this.revision) {
      this.revision = revision;
      this.dirty = true;
    }
    if (rotation !== this.rotation) {
      this.rotation = rotation;
      this.dirty = true;
    }
    if (widthPx !== this.width || heightPx !== this.height) {
      this.resize(widthPx, heightPx);
    }
    const key = subject === null ? null : subject.key;
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.build(subject);
    }
  }

  /** Force the next `bake` -- the safety valve, and the "a texture just landed" signal. */
  touch(): void {
    this.dirty = true;
  }

  /**
   * Draw the figure into the target, if anything has changed.
   *
   * Returns true when it actually rendered, which is what tells `world-ui.ts` that the interface
   * composite has to be re-rendered to pick the new pixels up.
   */
  bake(renderer: THREE.WebGLRenderer): boolean {
    const target = this.target;
    if (!this.dirty || target === null) {
      return false;
    }
    // Nothing to draw and the target already shows nothing -- see `blank`.
    if (this.model === null && this.blank) {
      this.dirty = false;
      return false;
    }
    this.dirty = false;
    this.blank = this.model === null;

    const previous = renderer.getRenderTarget();
    const savedAutoClear = renderer.autoClear;
    renderer.setRenderTarget(target);
    // TRANSPARENT, so the panel art behind the pane shows around the figure -- which is what the real
    // client's model pane does. The clear is explicit because `GlueRenderer` runs with
    // `autoClear = false` and nothing else would do it.
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;
    renderer.clear(true, true, false);

    if (this.model !== null) {
      this.pose();
      this.aim();
      this.light();
      renderer.render(this.scene, this.camera);
    }

    renderer.autoClear = savedAutoClear;
    renderer.setRenderTarget(previous);
    return true;
  }

  dispose(): void {
    this.token += 1;
    this.drop();
    this.target?.dispose();
    this.target = null;
  }

  private resize(widthPx: number, heightPx: number): void {
    const longest = Math.max(widthPx, heightPx, 1);
    const factor = longest > MAX_PANE_PIXELS ? MAX_PANE_PIXELS / longest : 1;
    const width = Math.max(1, Math.round(widthPx * factor));
    const height = Math.max(1, Math.round(heightPx * factor));
    if (width === this.width && height === this.height) {
      return;
    }
    this.width = width;
    this.height = height;
    if (this.target === null) {
      // `depthBuffer` is the default and is REQUIRED here, unlike the interface target: a figure is
      // solid geometry with its own back faces, and without depth the pane draws the inside of the
      // head.
      this.target = new THREE.WebGLRenderTarget(width, height);
      this.target.texture.name = `ModelBooth:${this.widgetId}`;
      this.target.texture.generateMipmaps = false;
      this.target.texture.minFilter = THREE.LinearFilter;
    } else {
      this.target.setSize(width, height);
    }
    this.dirty = true;
    // A resized target holds undefined contents whatever it held before, so the blank latch has to go
    // with it -- otherwise an empty pane would skip the clear and show whatever the driver left there.
    this.blank = false;
  }

  /** Load and dress a new figure, or clear the pane when its unit is gone. */
  private build(subject: BoothSubject | null): void {
    const token = ++this.token;
    this.drop();
    this.dirty = true;

    if (subject === null) {
      return;
    }
    if (subject.look !== null) {
      this.buildCharacter(subject.look, token);
      return;
    }
    if (subject.creature !== null) {
      this.buildCreature(subject.creature, token);
    }
  }

  /** A dressed character: the four `character/dress.ts` calls, in the order the world makes them. */
  private buildCharacter(look: CharacterLook, token: number): void {
    loadCharacter(look).then((loaded) => {
      const model = this.adoptModel(loaded.model, token, look.scale);
      if (model === null) {
        return;
      }
      // Scale, geosets and the three texture slots. `applyCharacterLook` calls `updateMatrix()`
      // itself, which is not optional: `M2` sets `matrixAutoUpdate = false` on itself, so
      // `scale.setScalar` alone reaches nothing -- the recorded trap, and the reason a gnome drew at
      // human size for several rounds.
      const textures = applyCharacterLook(model, look, loaded);
      armStand(model, look.modelPath);

      attachCharacterItems(
        model,
        look,
        () => this.token === token && this.model === model,
        (item) => {
          this.attached.push(item);
          // A frozen pane cannot notice a weapon that lands three frames later, so the arrival is
          // what re-bakes it. Without this the figure holds nothing for ever.
          this.dirty = true;
        },
      );

      // RETURNED, not dropped: a promise made inside a `.then` and not returned from it is what
      // bluebird warns about, and the pane genuinely is not finished until the body has its skin.
      return textures.then(() => {
        if (this.token === token) {
          this.dirty = true;
        }
      });
    });
  }

  /**
   * A creature: the display-id path, which is `classes/unit.ts#resolveDisplay`'s own tail.
   *
   * No geosets, no composite and no attachments -- a `CreatureDisplayInfo` row with no `extraInfoID`
   * carries texture VARIATIONS and nothing else, which is exactly what `setDisplayInfo` consumes. The
   * scale is the unit's RENDERED scale rather than the row's column, for the reason `renderScale`
   * gives: the server's object scale outranks the column, and reading the column here was a recorded
   * regression that shrank Northshire's wolves.
   */
  private buildCreature(
    creature: { modelPath: string; displayInfo: unknown; scale: number },
    token: number,
  ): void {
    M2Blueprint.load(creature.modelPath)
      .then((loaded: any) => {
        const model = this.adoptModel(loaded, token, creature.scale);
        if (model === null) {
          return undefined;
        }
        model.scale.setScalar(creature.scale);
        // BY HAND. `M2` sets `matrixAutoUpdate = false` on itself, so the line above is otherwise
        // inert -- the same trap `applyCharacterLook` documents on the other branch.
        model.updateMatrix();
        armStand(model, creature.modelPath);
        return model.setDisplayInfo(creature.displayInfo).then(() => {
          if (this.token === token) {
            this.dirty = true;
          }
        });
      })
      .catch((error: unknown) => {
        console.warn(`model booth: ${creature.modelPath} did not load`, error);
      });
  }

  /**
   * Put a freshly loaded model in the pane, or release it if the pane has moved on.
   *
   * Shared by both build paths because what differs between them is the dressing, and everything
   * about OWNING a loaded model is the same. Answers null when the load lost its race, having already
   * released the reference -- `M2Blueprint.unload` is reference-counted against a path and nothing
   * else would give it back.
   */
  private adoptModel(model: any, token: number, scale: number): any {
    if (this.token !== token) {
      M2Blueprint.unload(model);
      return null;
    }
    this.model = model;
    this.root.add(model);
    // `M2` constructs itself hidden and there is no visibility manager here -- the same line
    // `glue-scene.ts` needs, and the same silent black frame if it is missing. three's
    // `projectObject` returns before walking children of a hidden node, so this also decides
    // whether an attached weapon is ever drawn.
    model.visible = true;
    this.scale = scale;
    this.anchors = readAnchors(model);
    this.dirty = true;
    return model;
  }

  private drop(): void {
    // The attachments first, off their BONES rather than off `root` -- that is where `attachTo` put
    // them, and removing the body alone would strand them on a disposed skeleton with their
    // blueprint reference never released.
    for (const item of this.attached) {
      item.parent?.remove(item);
      M2Blueprint.unload(item);
    }
    this.attached = [];
    if (this.model !== null) {
      this.root.remove(this.model);
      M2Blueprint.unload(this.model);
    }
    this.model = null;
    this.anchors = null;
    // The target still holds the last figure until the next bake clears it, so this is NOT `blank`.
    this.blank = false;
  }

  /**
   * Solve the pose once, at the clock's current instant, and turn the figure.
   *
   * `poseModel`'s law, verbatim from `glue-scene.ts`: `applyPose()` only copies
   * `instanceAnim.localTRS` into the bone hierarchy and samples nothing, so without `solveBones`
   * every bone sits at its bind-pose offset for ever. The attachments are posed BEFORE the body so
   * the body's one recursive `updateMatrixWorld` covers them -- they are its scene-graph
   * descendants.
   */
  private pose(): void {
    const clock = worldClock.ms;
    for (const item of this.attached) {
      poseModel(item, clock);
    }
    poseModel(this.model, clock);
    // `SetRotation`. A `THREE.Group` keeps `matrixAutoUpdate`, so the write is not inert here the way
    // it would be on the M2 itself -- and `updateMatrixWorld` below is what pushes it down.
    this.root.rotation.z = this.rotation;
    this.root.updateMatrixWorld(true);
  }

  /**
   * Fit the camera. See `booth-framing.ts` for where every number comes from.
   *
   * A PORTRAIT takes the model's own authored camera and a BODY pane takes a fitted one, and the
   * reference is explicit that these are two different laws rather than one with a zoom
   * (`benilla/.../portrait/mod.rs:12-19`). A portrait on a model that ships no camera falls back to
   * the body fit, which is also what the reference does.
   */
  private aim(): void {
    const aspect = this.width / Math.max(this.height, 1);
    const anchors = this.anchors ?? EMPTY_ANCHORS;
    const bust = this.framing === 'portrait' ? portraitFrame(anchors, this.scale, aspect) : null;
    if (bust !== null) {
      this.camera.up.set(bust.up[0], bust.up[1], bust.up[2]);
      this.camera.position.set(bust.eye[0], bust.eye[1], bust.eye[2]);
      this.camera.lookAt(bust.target[0], bust.target[1], bust.target[2]);
      this.camera.near = bust.near;
      this.camera.far = bust.far;
      this.camera.aspect = aspect;
      this.camera.fov = THREE.MathUtils.radToDeg(bust.fovY);
      this.camera.updateProjectionMatrix();
      return;
    }
    const frame = bodyFrame(anchors, this.scale, aspect);
    // Restored explicitly: a previous portrait bake may have rolled `up` off the Z axis, and a
    // `PerspectiveCamera` keeps whatever was last written to it.
    this.camera.up.set(0, 0, 1);
    this.camera.near = 0.05;
    this.camera.far = 100;
    this.camera.position.set(frame.eye[0], frame.eye[1], frame.eye[2]);
    this.camera.lookAt(frame.target[0], frame.target[1], frame.target[2]);
    this.camera.aspect = aspect;
    this.camera.fov = THREE.MathUtils.radToDeg(frame.fovY);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Push the pane light into every material in the booth, for THIS draw.
   *
   * Per draw and not once, for the reason `applyPerObjectLighting` documents: three re-uploads a
   * material's uniforms only when the material changes between draws or when `uniformsNeedUpdate` is
   * set, and these materials belong to this clone alone -- nothing else would ever set it.
   *
   * Fog OFF. `rigFog(null)` pushes the band past the far plane rather than branching in the shader,
   * which is the same thing benilla's booth rows do ("fog OFF in the booth", `light.rs:192`).
   */
  private light(): void {
    const fog = rigFog(null);
    const color = new THREE.Color(fog.color[0], fog.color[1], fog.color[2]);
    this.scene.traverse((node: any) => {
      const material = node.material;
      if (!material?.uniforms) {
        return;
      }
      applyPerObjectLighting(material, {
        // The probe lane: a pane is lit by its widget's own light, never by the world's sun.
        interior: true,
        interiorFog: false,
        sunIntensity: 1,
        probe: (this.framing === 'portrait' ? this.portraitLighting : this.paneLighting).probe,
        // The widget carries exactly ONE light and it is directional (`light.rs:163-168`: "It is the
        // widget's ONLY light"), so there is nothing for the point lanes to hold.
        pointLights: [],
      });
      material.uniforms.fogColor.value.copy(color);
      material.uniforms.fogParams.value.fromArray(fog.params);
    });
  }
}

/**
 * A figure with no model loaded yet. Every height is floored by `bodyFrame`; the facing is the
 * model-space forward axis put through `modelToRender`, which is a constant 180-degree yaw -- see
 * `MODEL_FORWARD`.
 */
const EMPTY_ANCHORS: BodyAnchors = {
  pivotHeight: 0,
  headHeight: 0,
  cameraTargetHeight: 0,
  groundRadius: 0,
  front: RENDER_FORWARD,
  bust: null,
};

/** `glue-scene.ts#poseModel`, and its header is the derivation. */
function poseModel(model: any, clock: number): void {
  if (!model?.instanceAnim) {
    return;
  }
  model.evaluateMaterialChannels(clock);
  model.instanceAnim.solveBones(clock);
  model.applyPose();
}

/** Attachment id 17 -- the neck pivot, benilla's `pivot_height` ("every character carries it"). */
const ATTACH_NECK = 17;

/** Attachment id 11 -- the helm point, benilla's head fallback (`framing.rs:99-101`). */
const ATTACH_HELM = 11;

/** `AnimationData` key bone 6 -- the head bone, benilla's primary head anchor. */
const KEY_BONE_HEAD = 6;

/**
 * Read the framing anchors out of a loaded M2, once.
 *
 * Everything here is the model's OWN data, in model space at scale 1.
 *
 * THE FOOTPRINT IS THE COLLISION BOX, not the vertex box, and that distinction was the whole of one
 * defect. `maxVertexBox` covers every geoset the file carries at every keyframe of every animation:
 * on `HumanMale.m2` it is (2.22, 1.33, 3.38) against a `maxBoundingBox` of (0.31, 0.31, 2.03) -- a
 * "footprint radius" of 1.97 instead of 0.31. Fed to `bodyFrame`'s width floor that widened the
 * window from 2.50 to 4.18 and the figure came out at 60% of the size it should be, low in the pane.
 * The bounding box is the client's own collision hull and it is exactly the standing figure: 0.61
 * wide and 2.03 tall for a human male.
 */
function readAnchors(model: any): BodyAnchors {
  const data = model?.data ?? {};
  const attachments: any[] = data.attachments ?? [];
  const attachZ = (id: number): number => {
    const record = attachments.find((entry) => entry.id === id);
    return record ? record.position[2] : 0;
  };

  const headBone = (data.bones ?? []).find((bone: any) => bone.keyBoneID === KEY_BONE_HEAD);
  const headHeight = headBone ? headBone.pivotPoint[2] : attachZ(ATTACH_HELM);

  // THE BUST CAMERA, converted to render space once.
  //
  // Which camera: `cameraLookups[0]`, which is what the reference verified the real portrait bake
  // selects (`benilla/.../portrait/mod.rs:31-33`). The lookup table carries the 0xffff "none" sentinel
  // on some models -- `glue-scene.ts`'s own header records that every `UI_*` stage does -- so an
  // out-of-range slot falls back to camera 0 rather than to nothing.
  //
  // Camera tracks store `M2SplineKey<T>` triples, so a value is reached through `.value` -- indexing
  // the wrapper reads `undefined` off a struct and NaNs the frame (`glue-scene.ts#aimCamera`, which
  // paid for this once already).
  const cameras: any[] = data.cameras ?? [];
  const lookup = (data.cameraLookups ?? [])[0];
  const index = typeof lookup === 'number' && lookup >= 0 && lookup < cameras.length ? lookup : 0;
  const camera = cameras[index] ?? null;
  let bust: BustCamera | null = null;
  let cameraTargetHeight = 0;
  if (camera) {
    const eyeKey = camera.positions?.firstKeyframe?.value;
    const targetKey = camera.targetPositions?.firstKeyframe?.value;
    const eye = modelToRender([
      camera.positionBase[0] + (eyeKey ? eyeKey.value[0] : 0),
      camera.positionBase[1] + (eyeKey ? eyeKey.value[1] : 0),
      camera.positionBase[2] + (eyeKey ? eyeKey.value[2] : 0),
    ]);
    const target = modelToRender([
      camera.targetBase[0] + (targetKey ? targetKey.value[0] : 0),
      camera.targetBase[1] + (targetKey ? targetKey.value[1] : 0),
      camera.targetBase[2] + (targetKey ? targetKey.value[2] : 0),
    ]);
    cameraTargetHeight = target[2];
    bust = {
      eye, target,
      roll: camera.roll?.firstKeyframe?.value?.value ?? 0,
      fov: camera.fov,
      near: camera.nearClip,
      far: camera.farClip,
    };
  }

  const min = data.minBoundingBox;
  const max = data.maxBoundingBox;
  const groundRadius = min && max
    ? Math.max(Math.abs(min.x), Math.abs(max.x), Math.abs(min.y), Math.abs(max.y))
    : 0;

  return {
    pivotHeight: attachZ(ATTACH_NECK),
    headHeight,
    cameraTargetHeight,
    groundRadius,
    front: RENDER_FORWARD,
    bust,
  };
}

/**
 * What a unit's body is, as far as the booth is concerned.
 *
 * TWO supplies, because a world unit has two: a `CharacterLook` (players and the 15 451
 * `extraInfoID`-carrying humanoid NPC rows) or a `CreatureDisplayInfo` row (the other 8 811 -- the
 * wolves and the rabbits). `classes/unit.ts` answers exactly one of them per unit and the host asks
 * for both, because a portrait has to work for whatever the player is looking at.
 *
 * `key` is what CHANGE means, and it has to come from the host because the two supplies count
 * differently: a look is compared by object IDENTITY (`resolveCharacterLook` builds a fresh one per
 * redress, so a new object IS a gear change), while a creature's descriptor is rebuilt by its getter
 * on every read and has to be compared by display id instead. Getting that wrong is not a cosmetic
 * bug -- it is a re-bake per frame, which is the whole cost this subsystem is built to avoid.
 */
export interface BoothSubject {
  key: unknown;
  look: CharacterLook | null;
  creature: { modelPath: string; displayInfo: unknown; scale: number } | null;
}

/** How the host turns a `SetUnit`/`SetPortraitTexture` token into a body. */
export type SubjectForUnit = (unit: string) => BoothSubject | null;

/**
 * Every model pane in the world, keyed by widget id.
 *
 * Owned by `world-ui.ts`, driven once per UI frame from `render`. It is a class rather than a couple
 * of fields on the host because the whole of the model-to-texture decision lives here and the host's
 * job is one call and one boolean.
 */
export class ModelBooth {
  private readonly panes = new Map<string, Pane>();

  /** Tokens already reported as unresolvable, so an unknown unit warns once and not per frame. */
  private readonly warned = new Set<string>();

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  /**
   * One frame of booth work: find the model frames on screen, take their state, bake what changed.
   *
   * `valveDue` is the host's own "this frame is a full interface re-render anyway" flag; see the
   * redraw policy in the file header for why that is the free frame to re-bake on.
   *
   * `scale` is `layout.ts#screenScale` and `pixelRatio` is the renderer's, so a pane's target is
   * sized in the same device pixels the interface target is -- the two composite 1:1.
   *
   * Returns true when at least one pane was re-baked, which the host turns into a full interface
   * re-render so the new pixels are actually composited.
   */
  render(
    items: DrawItem[],
    art: GlueArt,
    subjectFor: SubjectForUnit,
    opts: { valveDue: boolean; scale: number; pixelRatio: number },
  ): boolean {
    let baked = false;

    for (const item of items) {
      const rig = item.widget.modelRig;
      // A frame with no rig has never had a model method called on it; a rig with no unit is a glue
      // `SetModel` pane, which the glue scene draws and this does not.
      if (rig === null || rig.unit === null) {
        continue;
      }
      const id = item.widget.id;
      let pane = this.panes.get(id);
      if (pane === undefined) {
        pane = new Pane(id);
        this.panes.set(id, pane);
      }

      const subject = subjectFor(rig.unit);
      if (subject === null && !this.warned.has(rig.unit)) {
        this.warned.add(rig.unit);
        console.warn(
          `model booth: ${id} asked for unit "${rig.unit}" and the world has no body for it; ` +
            'the pane stays empty',
        );
      }
      pane.request(
        subject,
        rig.revision,
        rig.rotation,
        rig.framing,
        item.rect.width * opts.scale * opts.pixelRatio,
        item.rect.height * opts.scale * opts.pixelRatio,
      );
      if (opts.valveDue) {
        pane.touch();
      }
      baked = pane.bake(this.renderer) || baked;

      // ADOPTED every frame, and idempotent by identity (`art.ts#adopt`): the target's texture object
      // survives a `setSize`, so this is a `Map` read once the pane is settled. Setting `sprite` is
      // what puts the pane in the draw list's own resolve path -- see the file header.
      const texture = pane.texture;
      if (texture !== null) {
        const key = paneKey(id);
        art.adopt(key, texture, FLIP_V);
        item.widget.sprite = key;
      }
    }

    return baked;
  }

  /**
   * Every live pane, for `window.worldUiBooth`. See `Pane#modelForDebug`.
   */
  debug(): unknown[] {
    return Array.from(this.panes.entries()).map(([id, pane]) => ({
      id,
      texture: pane.texture,
      model: pane.modelForDebug,
    }));
  }

  dispose(): void {
    this.panes.forEach((pane) => pane.dispose());
    this.panes.clear();
    this.warned.clear();
  }
}
