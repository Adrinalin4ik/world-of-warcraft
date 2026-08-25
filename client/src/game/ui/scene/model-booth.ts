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
 * A pane is baked ONLY when one of these is true, and every one of them changes what the picture IS:
 *
 *  1. the frame's rig `revision` moved -- a `SetUnit`, a `RefreshUnit`, or a `SetRotation`;
 *  2. the unit was redressed (`Unit#characterLook` is a new object), or the pane's subject changed;
 *  3. the model, its body textures, an attachment or an attachment's texture has just landed;
 *  4. the pane was resized, or its framing changed.
 *
 * THERE IS NO PERIODIC RE-BAKE. There was: the booth used to also bake on the frames `world-ui.ts` was
 * going to fully re-render anyway (`FULL_DRAW_EVERY`, one in twelve), on the argument that those frames
 * were already paid for. Free is not the same as right -- a portrait re-baked one frame in twelve
 * advances the Stand loop by 200 ms each time, which is a 5 fps animation, and the owner asked for a
 * still: "Я просил не 1 fps а один кадр. Т.е. 2д картинку без анимации." It is gone, and the late
 * arrivals it used to cover are each signalled directly instead (see (3), and `dress.ts#onSettled`).
 *
 * The POSE is frozen too, and separately: `Pane#poseClock` latches the world clock at the instant the
 * figure is adopted and every bake solves that same instant, so a legitimate re-bake -- a gear change,
 * or a drag of the paper doll -- reproduces the same stance rather than whatever frame of the idle the
 * clock has reached. Sampling the live clock was the actual mechanism of the animation the owner saw.
 *
 * This is the reference's own behaviour and not a shortcut: the real client "renders a unit's model
 * once into a tiny (64 squared) off-screen texture and freezes it (re-baked only on model change)"
 * (`benilla/.../portrait/mod.rs:4-6`), and benilla's own body pane bakes a "fresh throwaway instance
 * ... armed to the model's Stand and frozen, never the unit's live world pose" (`mod.rs:43-48`).
 * `CharacterModelFrame`'s own `<OnUpdate>` is `Model_OnUpdate`, which does nothing but sweep the yaw
 * while a rotate button is held (`uiparent.lua:2847-2865`) -- it never calls `AdvanceTime`. So a
 * breathing idle in the pane is a thing the client's own Lua does not ask for.
 *
 * The PAPER DOLL IS NOT THE PORTRAITS, and the two policies are deliberately not one. A portrait's rig
 * never changes rotation, so it bakes once per appearance and then never again. The paper doll's does,
 * on every mouse-move of a drag and every frame a rotate button is held -- so it re-bakes while it is
 * being turned, which is the whole of the owner-confirmed drag-to-rotate. Freezing that would be a
 * regression, not a fix.
 *
 * The measured consequence is in the task report.
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
 * the BODY without relighting the one standing in the world.
 *
 * **IT IS NOT SAFE FOR THE ATTACHMENTS, and this header used to claim otherwise.** A helm, a pauldron
 * and a weapon are static models, so `canInstance` is true and `M2#clone` hands them the SOURCE's
 * materials -- shared with every placement of that item path, the world's included. Pushing booth light
 * into those lit the character's own helm and shoulders permanently, which is the defect
 * `Pane#saveBorrowedLighting` exists to undo; read that before changing anything in `light()`.
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
import type { DrawItem, TexCoords } from '../widget';
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
 * THE PORTRAIT'S BACKDROP: opaque near-black, and it is the REFERENCE BAKE'S OWN COLOUR.
 *
 * `Color::srgb(0.055, 0.045, 0.04)` (`benilla/.../portrait/mod.rs:706-708`), carried with its reason
 * attached: "The ref bake's opaque near-black backdrop (**the world must never show through the
 * circle**); the round cut happens at draw time". Those sRGB components are the byte triple
 * `(14, 11, 10)` = `#0E0B0A`, which is what three's `setClearColor` wants. So the VALUE is sourced,
 * not a dark grey of ours.
 *
 * THE OWNER'S REPORT is that this was missing: "фон не черный, а должен быть. Сейчас он прозрачный."
 * It appeared with this round's destination-alpha fix -- once a pane composites BY ITS ALPHA (which is
 * what let the hairstyle survive at all), a target cleared to alpha 0 composites its empty region as
 * empty, so the world showed through the ring. The fix belongs to what the target is CLEARED to and
 * NOT to the blend rule: undoing the blend rule would bring the bald head straight back, and the round
 * stencil needs real alpha to cut with.
 *
 * IT DOES NOT FIGHT THE STENCIL. The clear fills the square opaque, the figure draws over it, and the
 * mask then multiplies alpha to zero outside the circle -- which is precisely the reference's division
 * of labour ("the round cut happens at draw time"). Inside the circle alpha is 1 everywhere, so the
 * backdrop is solid and the silhouette has no fringe.
 *
 * THE PAPER DOLL IS DELIBERATELY NOT GIVEN ONE. It stays transparent, so the panel art shows around
 * the figure -- the owner has confirmed that pane as correct ("Превью в окне одевания персонажа тоже
 * выглядит как надо"), and the reference marks its own near-black body pane as an unsettled choice
 * rather than the client's: "A transparent float-over-the-frame-art backdrop is a director's-call
 * follow-up" (`mod.rs:766-769`). Two laws, and the confirmed one is left alone.
 */
const PORTRAIT_BACKDROP = 0x0e0b0a;

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
 * THE ROUND ALPHA STENCIL a portrait is masked by, and the pass that stamps it.
 *
 * THE REFERENCE'S OWN STEP, and the real client's: "The real 1.12 client renders a unit's model once
 * into a tiny (64 squared) off-screen texture and freezes it (re-baked only on model change), **then
 * stamps a round alpha stencil into it**" (`benilla/.../portrait/mod.rs:4-5`). It is also explicit that
 * the body pane is NOT masked -- "The UI samples it *square*, not through the circular mask"
 * (`mod.rs:17-18`) -- which is why this runs on `framing === 'portrait'` and nothing else.
 *
 * THE OWNER'S REPORT IS ITS ABSENCE. "The preview goes out of the bounds", on the target frame, with
 * the player's frame in the same shot correct. Measured before writing anything, with a target up: of
 * the 1228 pixels of a 76x76 portrait target lying OUTSIDE the inscribed circle, 570 carried alpha --
 * a square render of a head that fills its frame, spilling past the round ring art. A narrow human
 * face happens to sit inside the circle and so looked contained; a wide muzzle does not.
 *
 * A MULTIPLY, not a draw. `dstA = dstA * srcA` and RGB untouched: `blendSrc`/`blendDst` are
 * `Zero`/`One` (the destination colour is kept verbatim) and `blendSrcAlpha`/`blendDstAlpha` are
 * `Zero`/`SrcAlpha`, since three's blend equation is `src * srcFactor + dst * dstFactor`. That is a
 * stencil rather than a black ring, so the mask cannot darken the face it trims and the pane keeps
 * showing the panel art around it.
 *
 * STRETCHED OVER THE QUAD, so a pane that is not square gets an inscribed ELLIPSE. That is what a
 * texture-space stencil does, it matches the reference (which stamps the stencil into the texture, not
 * into a circle of screen pixels), and every round portrait the client authors is square anyway.
 *
 * The mask, the quad, the camera and the scene are all MODULE-LEVEL and shared by every pane: none of
 * them holds per-pane state, and a portrait bake is now a rare event rather than a per-frame one, so a
 * copy per pane would be pure allocation. Built lazily, because a client that never shows a portrait
 * should not pay for a canvas.
 */
const MASK_PIXELS = 128;

let maskPass: { scene: THREE.Scene; camera: THREE.OrthographicCamera } | null = null;

function portraitMask(): { scene: THREE.Scene; camera: THREE.OrthographicCamera } {
  if (maskPass !== null) {
    return maskPass;
  }
  const canvas = document.createElement('canvas');
  canvas.width = MASK_PIXELS;
  canvas.height = MASK_PIXELS;
  const ctx = canvas.getContext('2d')!;
  // White at full alpha inside the circle, nothing outside. The RGB is never read -- the blend keeps
  // the destination's -- but a fully transparent fill still has to be cleared first, or the canvas's
  // default is undefined in some engines.
  ctx.clearRect(0, 0, MASK_PIXELS, MASK_PIXELS);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  // A radius one pixel inside the edge, so the anti-aliased rim of the circle is itself inside the
  // texture rather than clamped against its border.
  ctx.arc(MASK_PIXELS / 2, MASK_PIXELS / 2, MASK_PIXELS / 2 - 1, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'ModelBooth:portrait-mask';
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // The pane samples its target with `flipY = false` conventions (see `FLIP_V`), but this quad is
  // rendered THROUGH the same camera the figure is, so it needs no flip of its own -- the mask is
  // symmetric about both axes in any case, which is why this is stated rather than tested for.
  texture.needsUpdate = true;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.SrcAlphaFactor,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  // The whole target, in clip space: the quad is 2x2 about the origin and the camera frames exactly
  // that, so the mask covers the pane whatever its pixel size is.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  camera.position.set(0, 0, 1);

  maskPass = { scene, camera };
  return maskPass;
}

/**
 * LET THIS MODEL'S BATCHES WRITE DESTINATION ALPHA. This is the whole of the missing-hairstyle bug.
 *
 * `material/index.ts#applyBlendingModeToMaterial` ends with, for every blending mode >= 1:
 *
 *     material.blendSrcAlpha = THREE.ZeroFactor;
 *     material.blendDstAlpha = THREE.OneFactor;
 *
 * i.e. `dstA = 0 * srcA + 1 * dstA` -- the draw is forbidden from touching the framebuffer's alpha
 * channel at all. That is correct and deliberate for the world: it emulates the reference's OPAQUE
 * backbuffer, and its own comment records what it bought (three requests a `premultipliedAlpha`
 * context unconditionally, so any sub-1 alpha left in the canvas gives the fragment a bright halo --
 * "all of Elwynn's foliage gained a white fringe"). It is FATAL in a pane, because a pane's target is
 * composited into the interface BY ITS ALPHA: a batch that writes colour and no alpha writes nothing
 * the viewer can see.
 *
 * A character's hair geoset is blending mode 1 (alpha key). Its body is mode 0, which is `NoBlending`
 * -- the factors are ignored and the shader's own alpha reaches the buffer -- which is exactly why the
 * body appeared and the hairstyle did not, on a model whose geoset selection, bound texture objects,
 * skinned bounds, material state and per-batch draw counts are all IDENTICAL to the world's. Measured:
 * with only the hair geoset visible, the paper-doll target held 983 pixels carrying colour and alpha
 * <= 8/255, and the sword (mode 0) was the only thing in the pane with alpha at all.
 *
 * ONE / ONE-MINUS-SRC-ALPHA, i.e. `dstA = srcA + dstA * (1 - srcA)`: standard coverage accumulation,
 * and the same "over" rule the RGB factors of mode 2 already use. For mode 1 the shader's alpha is
 * `vertexColor.a` (`fragment/combiners-opaque.glsl`), so a kept cutout texel stores 1 and the geoset
 * comes out solid; for the genuinely blended modes the pane's coverage grows with what is drawn into
 * it, which is what a sprite over panel art needs.
 *
 * GUARDED ON `ownsBatches`, and the guard is load-bearing rather than defensive. An instanceable M2
 * shares its materials with every other placement of the same path (`M2#clone` passes
 * `instance.batches`, `pipeline/m2/index.ts:348-353`), so writing blend factors on one would change
 * the world's copy -- the precise mistake the file header claims this subsystem avoids. Characters and
 * creatures animate, so `canInstance` is false for both and every figure a pane draws owns its
 * materials; a shared-batch model (a static attached item) keeps the world's rule, which costs it
 * nothing because such items are mode 0 and already write their alpha.
 *
 * Answers whether it did anything, so the caller can say when it did not.
 */
export function allowDestinationAlpha(model: any): boolean {
  if (model?.ownsBatches !== true) {
    return false;
  }
  for (const submesh of model.submeshes ?? []) {
    for (const batch of submesh.children ?? []) {
      const material = batch?.material;
      // Mode 0 is `NoBlending` and writes the shader's alpha directly; nothing to correct, and
      // touching its factors would be a no-op three still has to re-read.
      if (material === undefined || material.blending !== THREE.CustomBlending) {
        continue;
      }
      material.blendSrcAlpha = THREE.OneFactor;
      material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
  }
  return true;
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
 * The same V flip, applied to a crop the CLIENT authored rather than to the whole texture.
 *
 * WHY THIS IS NEEDED AT ALL, and it is the bottom-bar defect. `renderer.ts:369` resolves a sprite's
 * sub-rect as `item.texCoords ?? item.widget.texCoords ?? resolved.texCoords`, so a widget with its
 * OWN authored `<TexCoords>` outranks the `FLIP_V` the booth hands to `art.adopt` -- and the flip is
 * simply lost. `MicroButtonPortrait` is exactly that widget: 18x25 with
 * `<TexCoords left="0.2" right="0.8" top="0.0666" bottom="0.9"/>` (the game's own
 * `mainmenubarmicrobuttons.xml:43-55`), so the character face on the micro-menu button was drawn
 * UPSIDE DOWN and cropped to a sub-rect of a squashed render. That is the owner's "превью на нижней
 * панели непонятное, толи скейл не тот, толи что-то другое" -- both halves of his guess were right.
 *
 * A framebuffer's `v = 0` is at the BOTTOM while every authored crop is written against a top-down
 * image, so the flip is `v -> 1 - v` on whatever rect the client asked for. The whole-texture case
 * `{0,0,1,1}` comes out as `FLIP_V`, which is what makes this a generalisation rather than a second
 * rule.
 */
export function flipCropV(tc: TexCoords | null | undefined): TexCoords {
  if (!tc) {
    return FLIP_V;
  }
  return { u0: tc.u0, v0: 1 - tc.v0, u1: tc.u1, v1: 1 - tc.v1 };
}

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

/**
 * The side of a portrait's SQUARE target, in device pixels.
 *
 * `max(w / uSpan, h / vSpan)` -- the smallest square whose CROPPED window is at least 1:1 with the
 * pixels the widget actually shows. See `Pane#resize` for why a portrait's target is square at all.
 * A span is floored rather than trusted: a degenerate `<TexCoords>` with equal edges would otherwise
 * divide by zero and ask for an infinite target.
 */
export function portraitTargetSide(
  widthPx: number,
  heightPx: number,
  crop: TexCoords | null | undefined,
): number {
  const uSpan = crop ? Math.abs(crop.u1 - crop.u0) : 1;
  const vSpan = crop ? Math.abs(crop.v1 - crop.v0) : 1;
  return Math.max(widthPx / Math.max(uSpan, 0.01), heightPx / Math.max(vSpan, 0.01));
}

/**
 * One material's lighting values, held across a bake so the world gets them back. See
 * `Pane#saveBorrowedLighting` for why an attachment's material is not the pane's to keep.
 */
interface BorrowedLighting {
  material: any;
  sunIntensity: number;
  interiorProbe: number;
  interiorFog: number;
  probeCoeffs: Float32Array;
  fogColor: THREE.Color;
  fogParams: number[];
}

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

  /** The CLAMPED target size, in device pixels. */
  private width = 0;

  private height = 0;

  /** The size last ASKED for, rounded -- what `request` compares against. See its comment. */
  private requestedWidth = 0;

  private requestedHeight = 0;

  /** The crop last asked for, flattened -- what the size comparison in `request` tests. */
  private requestedCrop = '';

  private model: any = null;

  private attached: any[] = [];

  /** The subject key the current model was built from -- see `BoothSubject.key`. */
  private builtKey: unknown = undefined;

  /** Which `build` the in-flight load belongs to. Monotonic, like the glue scene's. */
  private token = 0;

  private revision = -1;

  private rotation = 0;

  /**
   * The world-clock instant every bake of the CURRENT figure is posed at. See `adoptModel`.
   *
   * One frame means one frame: this is latched when the model is adopted and never advanced, so two
   * bakes of the same figure are the same picture. 0 while no model is loaded, which `pose()` never
   * reaches.
   */
  private poseClock = 0;

  private framing: 'body' | 'portrait' = 'body';

  /** The client's authored crop on this pane's widget, or null. See `request` and `resize`. */
  private crop: TexCoords | null = null;

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
    framing: 'body' | 'portrait', widthPx: number, heightPx: number,
    /**
     * The crop the CLIENT authored on this widget, or null for the whole texture.
     *
     * Read only to SIZE a portrait's square target -- see `resize`. The flip that makes it samplable
     * is `flipCropV`, applied by `ModelBooth#render`.
     */
    crop: TexCoords | null): void {
    this.crop = crop;
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
    // ROUNDED BEFORE COMPARING, caught in this round's own diff review. `widthPx` is a float (a 233-unit
    // pane at scale 1.186 is 276.38 device pixels) and `this.width` holds the ROUNDED, clamped target
    // size, so comparing them directly never settled and `resize` was called on every frame for ever.
    // Harmless -- `resize` bails on the same comparison a second time -- but a per-frame call that can
    // never succeed is exactly the shape a later reader would take for a bug.
    //
    // THE CROP IS PART OF THE COMPARISON, because for a portrait it is part of the target's SIZE (see
    // `resize`). A widget's `<TexCoords>` is authored and so changes at most once -- null on whatever
    // frame the rig appears before the draw item carries it -- but that once is the frame that decides
    // how big the square is, and comparing only the rect would keep the first answer for ever.
    const cropKey = this.crop === null ? '' : `${this.crop.u0},${this.crop.v0},${this.crop.u1},${this.crop.v1}`;
    if (Math.round(widthPx) !== this.requestedWidth || Math.round(heightPx) !== this.requestedHeight
      || cropKey !== this.requestedCrop) {
      this.requestedWidth = Math.round(widthPx);
      this.requestedHeight = Math.round(heightPx);
      this.requestedCrop = cropKey;
      this.resize(widthPx, heightPx);
    }
    const key = subject === null ? null : subject.key;
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.build(subject);
    }
  }

  /**
   * Force the next `bake`.
   *
   * No caller inside this file needs it any more -- the build path sets `dirty` directly. It is kept
   * because it is the ONLY way an instrument can ask a frozen pane to redraw, and a frozen pane is now
   * genuinely frozen: probe 23's readback of the pane's own target needed exactly this.
   */
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
    // SAVED AND RESTORED, caught in this round's own diff review. The bake runs BEFORE the interface's
    // own pass, which sets its own clear colour and restores the world's afterwards -- so today a bake
    // is always followed by that restore and the leak is invisible. It stops being invisible the moment
    // the interface target does not exist (`world-ui.ts#target` can answer null) or the order changes,
    // and "the world clears to transparent" is a whole-screen defect for a saved line.
    const savedClearColor = renderer.getClearColor(new THREE.Color());
    const savedClearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    // A PORTRAIT gets the reference bake's opaque near-black; a BODY pane stays transparent so the
    // panel art shows around the figure. See `PORTRAIT_BACKDROP` for both halves and their sources.
    // The clear is explicit because `GlueRenderer` runs with `autoClear = false` and nothing else
    // would do it.
    //
    // GATED ON THERE BEING A FIGURE, and not on the framing alone: a portrait whose unit this client
    // cannot give a body to (`subject === null`) would otherwise draw an opaque black DISC where it
    // used to draw nothing at all -- a backdrop exists to back something.
    if (this.framing === 'portrait' && this.model !== null) {
      renderer.setClearColor(PORTRAIT_BACKDROP, 1);
    } else {
      renderer.setClearColor(0x000000, 0);
    }
    renderer.autoClear = false;
    renderer.clear(true, true, false);

    if (this.model !== null) {
      this.pose();
      this.aim();
      // BORROWED, NOT OWNED: an attached item's materials are shared with every placement of that item
      // path in the world, so the booth's studio light has to be handed back the moment this bake is
      // done. See `saveBorrowedLighting` -- this is the "helm and shoulders are always bright" fix.
      const borrowed = this.saveBorrowedLighting();
      this.light();
      renderer.render(this.scene, this.camera);
      // The round stencil, over the figure. AFTER the figure and never before it: it multiplies the
      // alpha that is already in the target, so an empty target would be masked to nothing. Portraits
      // only -- the body pane is sampled square, which is the reference's own split
      // (`portraitMask`, and `benilla/.../portrait/mod.rs:17-18`).
      if (this.framing === 'portrait') {
        const mask = portraitMask();
        renderer.render(mask.scene, mask.camera);
      }
      // AFTER the draw and before anything else renders, so the world's own helm and shoulders are
      // never drawn with the booth's light.
      this.restoreBorrowedLighting(borrowed);
    }

    renderer.autoClear = savedAutoClear;
    renderer.setRenderTarget(previous);
    renderer.setClearColor(savedClearColor, savedClearAlpha);
    return true;
  }

  dispose(): void {
    this.token += 1;
    this.drop();
    this.target?.dispose();
    this.target = null;
  }

  /**
   * Size the target.
   *
   * A PORTRAIT'S TARGET IS SQUARE, and that is the other half of the bottom-bar defect. The size used
   * to be the widget's own rect, so `MicroButtonPortrait`'s 18x25 slot got an 18x25 render: the bust
   * was squashed to a 0.72 aspect, and once this round added the round stencil the circle became a
   * squashed ellipse too. The real client bakes ONE square portrait and lets each widget sample a
   * sub-rect of it -- which is exactly what that widget's `<TexCoords>` is for -- so a square target is
   * what its authored crop is written against.
   *
   * THE SIDE IS CHOSEN SO THE CROPPED WINDOW IS 1:1 WITH THE WIDGET'S PIXELS: `side = max(w / uSpan,
   * h / vSpan)`. For the micro button (21x30 device pixels through a 0.6 x 0.833 window) that is 36
   * squared, where sizing off the rect gave 21x30 -- so the visible face gets MORE pixels, not fewer,
   * and none of them are stretched. With no authored crop the spans are 1 and this degenerates to
   * `max(w, h)`, which leaves the 76x76 player portrait exactly as it was.
   *
   * A BODY PANE IS UNTOUCHED and keeps taking its rect verbatim: the paper doll is owner-confirmed at
   * 233x215 -> 276x255 and its aspect is the one `bodyFrame` fits the figure to.
   */
  private resize(rawWidthPx: number, rawHeightPx: number): void {
    let widthPx = rawWidthPx;
    let heightPx = rawHeightPx;
    if (this.framing === 'portrait') {
      const side = portraitTargetSide(rawWidthPx, rawHeightPx, this.crop);
      widthPx = side;
      heightPx = side;
    }
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
          // An attached item that owns its own materials needs the same alpha correction the body
          // does -- a helm with an alpha-keyed feather would otherwise be a hole in the pane. No
          // warning on the false branch here, unlike the body's: a static item model IS instanceable,
          // so sharing is the NORMAL case for an attachment and its batches are mode 0.
          allowDestinationAlpha(item);
          // A frozen pane cannot notice a weapon that lands three frames later, so the arrival is
          // what re-bakes it. Without this the figure holds nothing for ever.
          this.dirty = true;
        },
        // ...and the arrival is not enough on its own. `attachCharacterItems` attaches the model
        // BEFORE its texture resolves, so the bake above draws the item with the shared placeholder
        // skin. That used to be corrected by the next safety-valve bake; with the valve gone (see
        // `ModelBooth#render`) nothing else would ever re-bake it, and a sword would stay flat grey
        // for the life of the pane.
        () => {
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
    // THE POSE INSTANT, LATCHED. `pose()` used to sample `worldClock.ms`, so every bake solved the
    // Stand loop at a LATER instant than the one before -- a portrait re-baked on the safety valve was
    // therefore a 5 fps animation, which is what the owner reported ("Анимация все равно проходит в
    // превью... Я просил не 1 fps а один кадр"). Freezing the instant is what makes a legitimate
    // re-bake (a gear change, a drag of the paper doll) reproduce the SAME stance instead of whatever
    // frame of the idle it happens to land on.
    //
    // This value and the one `armStand` arms the sequence with are the same read of the same clock in
    // the same turn -- `armStand` is called from the caller's next statement -- so the latched instant
    // is Stand's t = 0, its first keyframe. That is the reference's own choice of frame: benilla's
    // booth arms "the model's Stand and frozen, never the unit's live world pose"
    // (`benilla/.../portrait/mod.rs:43-48`).
    this.poseClock = worldClock.ms;
    this.root.add(model);
    // `M2` constructs itself hidden and there is no visibility manager here -- the same line
    // `glue-scene.ts` needs, and the same silent black frame if it is missing. three's
    // `projectObject` returns before walking children of a hidden node, so this also decides
    // whether an attached weapon is ever drawn.
    model.visible = true;
    this.scale = scale;
    this.anchors = readAnchors(model);
    // See `allowDestinationAlpha`: without this the pane draws a character's hair geoset -- and every
    // other alpha-keyed or alpha-blended batch -- as colour with no coverage, which the interface
    // composite samples as nothing at all.
    if (!allowDestinationAlpha(model)) {
      console.warn(
        `model booth: ${this.widgetId}'s figure shares its materials with the world (` +
          `ownsBatches false), so its alpha-keyed batches cannot be made to write pane alpha; ` +
          'any cutout geoset it carries will be invisible in the pane',
      );
    }
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
   * The lighting values the booth is about to overwrite on materials it DOES NOT OWN, so they can be
   * put back.
   *
   * THIS IS THE FIX FOR "THE HELM AND SHOULDERS ARE ALWAYS BRIGHT" -- the owner's
   * "Плечи и шлем всегда выглядят так как будто наведен курсор. Более светлое чем все остальное."
   *
   * The mechanism, and this file's own header was WRONG about it. It claimed "a character clone
   * rebuilds its own batches and materials -- which is what makes it safe to push booth lighting into
   * them". True for the BODY, false for the ATTACHMENTS: a helm, a pauldron and a weapon are static
   * models, so `canInstance` is true, so `M2#clone` passes `instance.batches` and their materials are
   * SHARED with every other placement of that item path -- including the ones on the character standing
   * in the world. `Pane#light` traverses the whole pane scene, so it was writing the booth's interior
   * studio probe (`interior: true`, `sunIntensity: 1`, ambient 0.7 grey) straight into the world's helm
   * and shoulders.
   *
   * And the world does not correct it. `WorldMap#updateAllMaterialsWithLight` is skipped by
   * `MapLight.revision` -- deliberately, because it was 3.2 ms per frame over 20 258 materials to copy
   * values that changed on 1 frame in 401 -- so the booth's write stays until the zone's light happens
   * to move, and `applyLight` does not own the per-object probe lane anyway. Hence PERMANENTLY brighter,
   * and only on the attachment set, which is exactly the report.
   *
   * SAVE AND RESTORE rather than skip, so both pictures stay right: the pane draws its items under the
   * widget's own light (which is the reference's law for a booth) and the world gets its own values back
   * before anything else renders. It is the same pattern `bake` already uses for the renderer's clear
   * colour, and it was the right answer there for the same reason.
   *
   * Only `pointLights: []` is passed by `light()`, so `wmoLightPosition`/`wmoLightColor` are never
   * written and are not saved -- `applyPerObjectLighting` only touches slots below `count`, and count
   * comes out 0.
   */
  private saveBorrowedLighting(): BorrowedLighting[] {
    const saved: BorrowedLighting[] = [];
    for (const item of this.attached) {
      // A model that OWNS its batches has private materials and wants the booth's light kept.
      if (item?.ownsBatches === true) {
        continue;
      }
      for (const submesh of item?.submeshes ?? []) {
        for (const batch of submesh.children ?? []) {
          const u = batch?.material?.uniforms;
          if (u === undefined || u.probeCoeffs === undefined) {
            continue;
          }
          saved.push({
            material: batch.material,
            sunIntensity: u.sunIntensity.value,
            interiorProbe: u.interiorProbe.value,
            interiorFog: u.interiorFog.value,
            probeCoeffs: Float32Array.from(u.probeCoeffs.value),
            fogColor: u.fogColor.value.clone(),
            fogParams: u.fogParams.value.toArray(),
          });
        }
      }
    }
    return saved;
  }

  /** Put back what `saveBorrowedLighting` took, and raise the flag that makes it reach the GPU. */
  private restoreBorrowedLighting(saved: BorrowedLighting[]): void {
    for (const entry of saved) {
      const u = entry.material.uniforms;
      u.sunIntensity.value = entry.sunIntensity;
      u.interiorProbe.value = entry.interiorProbe;
      u.interiorFog.value = entry.interiorFog;
      u.probeCoeffs.value.set(entry.probeCoeffs);
      u.fogColor.value.copy(entry.fogColor);
      u.fogParams.value.fromArray(entry.fogParams);
      // Without this the restore never reaches the GPU: three re-uploads a `ShaderMaterial`'s uniforms
      // only on a program swap or when this is set -- the same line `applyPerObjectLighting` ends with.
      entry.material.uniformsNeedUpdate = true;
    }
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
    // THE LATCHED INSTANT, not `worldClock.ms`. See `poseClock`: sampling the live clock here made
    // every re-bake a later frame of the Stand loop, so the pane animated at whatever rate it was
    // re-baked. The attachments take the same instant as the body -- a sword posed at a different
    // moment than the hand holding it is the same defect one joint further out.
    const clock = this.poseClock;
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
   * THERE IS NO PERIODIC RE-BAKE, and its removal is the point. It used to take the host's "this frame
   * is a full interface re-render anyway" flag and `touch()` every pane on it -- free in dirty frames,
   * and wrong: a portrait re-baked one frame in twelve is a 5 fps animation of the Stand loop, which
   * is what the owner reported and which reads worse than either a still or a live model. The only
   * things that may re-bake a pane now are the ones that change what the picture IS: a new subject, a
   * rig revision (`SetUnit`/`RefreshUnit`/`SetRotation`), a resize, and the model / its textures / an
   * attachment / an attachment's texture arriving.
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
    opts: { scale: number; pixelRatio: number },
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
        item.widget.texCoords,
      );
      baked = pane.bake(this.renderer) || baked;

      // ADOPTED every frame, and idempotent by identity (`art.ts#adopt`): the target's texture object
      // survives a `setSize`, so this is a `Map` read once the pane is settled. Setting `sprite` is
      // what puts the pane in the draw list's own resolve path -- see the file header.
      const texture = pane.texture;
      if (texture !== null) {
        const key = paneKey(id);
        art.adopt(key, texture, FLIP_V);
        item.widget.sprite = key;
        // THE FLIP GOES ON THE ITEM, not only on the def, and that is the bottom-bar fix.
        // `renderer.ts:369` resolves `item.texCoords ?? item.widget.texCoords ?? resolved.texCoords`,
        // so for any widget carrying its own authored `<TexCoords>` -- `MicroButtonPortrait` is one --
        // the `FLIP_V` handed to `adopt` never won and the pane was sampled upside down. The per-frame
        // override is the seam that outranks both, and it is what the StatusBar fill already uses
        // (`widget.ts:715-721`). `flipCropV` composes the flip WITH the client's crop rather than
        // replacing it, so the micro button still shows the slice the client asked for.
        item.texCoords = flipCropV(item.widget.texCoords);
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
