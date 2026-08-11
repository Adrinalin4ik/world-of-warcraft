/**
 * The two glue blend modes.
 *
 * Unlit, depth-test off, drawn in the order the draw list dictates. ADD exists because a lot of
 * glue art is authored to glow (the reference needed a dedicated additive UI material for the same
 * reason: benilla `glue/add_material.rs`).
 */
import * as THREE from 'three';

import { Blend, TexCoords } from './widget';

/**
 * THE BLACK SQUARE ROUND THE CAST BAR, and it was a blend function, not a missing texture.
 *
 * ## What the owner saw
 *
 * A black rectangle behind and beside the cast bar, wider than the bar itself. The bar is 195x13 and
 * `CastingBarFrameSpark` is a **32x32** texture anchored `CENTER` and slid along it
 * (`castingbarframe.xml:62-69`, positioned at `castingbarframe.lua:279`), so it overhangs the bar by ~9 px
 * top and bottom and hangs off its left end early in a cast. That is the reported geometry exactly.
 *
 * ## Why an ADD texture came out opaque black
 *
 * `UI-CastingBar-Spark.blp` is DXT1 with **`alphaSize = 0`** -- opaque over its whole 32x32 -- and 82% of its
 * pixels are near-black. That is normal for 3.3.5a's additive art: the blend mode is what was supposed to
 * discard the black background, so the art never needed an alpha mask.
 *
 * The world UI renders into a TRANSPARENT OFFSCREEN TARGET and composites it over the 3D scene, so its
 * materials are premultiplied (`world-ui.ts` builds its `GlueRenderer` with `premultipliedAlpha` true; the
 * glue pass builds one with false, which is why the login screen's additive art never showed this). three's
 * `AdditiveBlending` with `premultipliedAlpha` resolves to an UN-SEPARATED `gl.blendFunc(ONE, ONE)`, and
 * un-separated means it applies to the ALPHA channel too:
 *
 *     dstA = srcA + dstA  ->  1 + dstA  ->  saturates to 1
 *
 * while the spark's own RGB contribution is about 0.05. The composite then reads that alpha
 * (`premultipliedAlpha` NormalBlending, i.e. `ONE, ONE_MINUS_SRC_ALPHA`):
 *
 *     out = targetRGB + world * (1 - targetA)  ->  0.05 + world * 0  ->  near-black, and it MASKS THE WORLD
 *
 * So the additive quad punched an opaque hole in the interface layer. Nothing was wrong with the art or the
 * anchors: `UI-CastingBar-Border.blp` loads (HTTP 200, DXT3, `alphaSize = 8`) and every region in
 * `castingbarframe.xml` declares anchors, so this is NOT a third member of the no-anchor family that
 * `PlayerFrameTexture` and the anchorless-frame defect belonged to. The one authored solid black quad in
 * that file -- `castingbarframe.xml:7-9`, `setAllPoints` with `<Color r=0 g=0 b=0 a=0.5>` -- is the bar's own
 * background and is correct at 195x13.
 *
 * ## The fix
 *
 * Separate the alpha blend so an additive quad adds COLOUR and leaves the destination alpha alone:
 * `blendSrcAlpha = ZERO`, `blendDstAlpha = ONE` gives `dstA = 0 * srcA + 1 * dstA`, unchanged. three has no
 * preset for the separated form, so this is `CustomBlending`. Only the premultiplied pass needs it: in the
 * straight-alpha glue pass the destination is the opaque canvas and its alpha is never read.
 *
 * **This is a FAMILY, not one texture.** Every ADD-mode texture in 3.3.5a is authored opaque-with-black, so
 * the same two lines were blackening `ButtonHilight-Square` (`alphaSize = 0`, 64x64) on a hovered action
 * button, `CheckButtonHilight` on a checked one, and `UI-ActionButton-Border`
 * (`actionbuttontemplate.xml:48,87,88`). One fix, several symptoms.
 */
export function applyBlend(
  material: THREE.MeshBasicMaterial,
  blend: Blend,
  premultipliedAlpha: boolean,
): void {
  if (blend !== 'ADD') {
    material.blending = THREE.NormalBlending;
    return;
  }
  if (!premultipliedAlpha) {
    material.blending = THREE.AdditiveBlending;
    return;
  }
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
}

export function createQuadMaterial(
  blend: Blend,
  premultipliedAlpha = false,
): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // Straight alpha by DEFAULT, which is what drawing over an opaque 3D stage wants: the note this
    // replaces said "premultiplied would double-darken the client's straight-alpha art", and that is
    // only half true -- three's `premultipliedAlpha` makes the SHADER multiply rgb by a and then
    // blends with `(ONE, ONE_MINUS_SRC_ALPHA)`, which is arithmetically the same colour, not a
    // double-darkening. What it also does is accumulate the DESTINATION ALPHA correctly, which only
    // matters when the destination is a transparent offscreen target that will be composited later.
    // `renderer.ts#GlueRenderer.premultiplied` is where that choice is argued and who asks for it.
    premultipliedAlpha,
    // DOUBLE-SIDED, and not by laziness. The UI's orthographic camera is Y-DOWN (`top = 0`,
    // `bottom = height`), which makes the projection's Y scale negative — a mirror. A mirror
    // reverses triangle winding, and three.js only compensates for winding flips coming from an
    // object's own world matrix determinant, never from the camera's projection. So under
    // `FrontSide` every UI quad presents its back face and is culled: draw calls are issued,
    // triangles are counted, and not one pixel lands. Depth testing is already off here, so there is
    // nothing to gain from single-sided culling anyway.
    side: THREE.DoubleSide,
  });
  // AFTER construction, because the separated-alpha form needs six fields the constructor's `blending`
  // shorthand cannot express. `renderer.ts` calls the same function on a material already in its pool, so a
  // quad that flips ADD -> ALPHA cannot keep the separated alpha equation: naming `NormalBlending` is enough,
  // because three's own `setBlending` never reads the custom factors on a preset branch and resets its cache
  // of them (`three.cjs`, `WebGLState.setBlending`).
  applyBlend(material, blend, premultipliedAlpha);
  return material;
}


/**
 * Point a material's map at a sub-rectangle of its sheet.
 *
 * No V flip. Two conventions cancel: `TextureLoader` creates every texture with `flipY = false`
 * (three.js cannot flip a compressed upload), so image row 0 is `v = 0`; and the UI's orthographic
 * camera is Y-DOWN, which puts the quad's `v = 0` edge at the TOP of the screen. Introduce a flip
 * here and every sprite draws upside down.
 */
export function applyTexCoords(
  material: THREE.MeshBasicMaterial,
  texCoords: TexCoords | null,
): void {
  const map = material.map;
  if (!map) {
    return;
  }

  if (!texCoords) {
    map.offset.set(0, 0);
    map.repeat.set(1, 1);
    return;
  }

  map.offset.set(texCoords.u0, texCoords.v0);
  map.repeat.set(texCoords.u1 - texCoords.u0, texCoords.v1 - texCoords.v0);
}
