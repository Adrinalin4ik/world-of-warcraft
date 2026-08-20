/**
 * BODY FRAMING for a model pane: where to put the camera so a standing figure fills the frame.
 *
 * This is the arithmetic half of `model-booth.ts`, split out because it is the one part of the booth
 * that is pure and therefore testable without a GL context -- the same split `scene-rig.ts` already
 * makes against `glue-scene.ts`.
 *
 * ## Why a fitted camera rather than the model's own
 *
 * A character `.m2` DOES ship a camera, and it is the framing the real client uses for the round
 * unit-frame portrait: a tight bust crop the artist calibrated per model. It is NOT the paper doll's
 * framing -- the reference is explicit that the body pane "frames the whole standing figure from the
 * model's bounds (`framing::body_frame`, not the authored bust camera)"
 * (`samples/benilla/crates/benilla/src/portrait/mod.rs:12-19`). So the camera below is fitted. The
 * model's own camera still contributes ONE number -- the height its bust framing looks at, which is a
 * throat/face signal and is one of the three the window is sized from -- but not its position; see
 * `BodyAnchors.front` for what reading its position did.
 *
 * ## What is ported and what is ours
 *
 * The SHAPE is `benilla/crates/benilla/src/portrait/framing.rs:247-279` line for line: a head-height
 * signal taken as the max of the neck pivot, the bust camera's look target and the head bone; a
 * window from that signal by a headroom/footroom pair; a floor on the window so a wide model cannot
 * out-reach the sides; and a standoff that fits the window exactly through the projection's own
 * vertical opening.
 *
 * The four dials (`BODY_FOV`, `HEADROOM`, `FOOTROOM`, `WIDTH_MARGIN`) are benilla's own numbers
 * (framing.rs:215-226). They are NOT client data and nothing in the game's files sets them; they are
 * a heuristic, and they are taken rather than re-invented because the reference has already tuned
 * them against real captures across the gnome-to-tauren range.
 *
 * The one place this deliberately does NOT follow the reference is the diagonal-to-vertical factor.
 * benilla hardcodes 0.6 because its booth renders square with a fixed 4/3 crop
 * (`framing.rs:23`, `DIAG_TO_VERT`). This client already transcribes the client's own projection
 * build as `scene-rig.ts#verticalFov` -- `fov / sqrt(aspect^2 + 1)`, of which 0.6 is just the 4:3
 * case -- and the pane is 233x215, not square. Using the law at the pane's real aspect is the same
 * mechanism with the game's own number instead of the reference's specialisation of it.
 */
import { verticalFov } from './scene-rig';

/**
 * The pane camera's DIAGONAL opening angle, in radians -- benilla `framing.rs:215`, and its comment
 * gives the reason for a mild angle: "a standing figure should read with little perspective
 * distortion".
 */
export const BODY_FOV = 0.85;

/** Air above the head signal, as a multiple of it. benilla `framing.rs:220`. */
const HEADROOM = 1.24;

/** Ground room below the feet, as a multiple of the head signal. benilla `framing.rs:223`. */
const FOOTROOM = 0.1;

/** Slack on a wide model's footprint before the window is widened for it. benilla `framing.rs:226`. */
const WIDTH_MARGIN = 1.15;

/**
 * The heights and the facing a pane camera is fitted from, all in MODEL space at scale 1 (feet at
 * z = 0, z up) except `front`, which is already in render space.
 *
 * Every height may legitimately be 0: `bodyFrame` floors the signal, so a prop with no neck, no head
 * bone and no camera still frames rather than divides by zero. That is the reference's own rule
 * (`framing.rs:251-255`, `.max(0.1)`).
 */
export interface BodyAnchors {
  /** The neck pivot -- attachment id 17. benilla's `pivot_height`, "every character carries it". */
  pivotHeight: number;
  /** Key bone 6 (head) pivot z, else the helm attach point (id 11). benilla's `head`. */
  headHeight: number;
  /** The bust camera's look target z. benilla's `camera.target.y` (its Y is our Z). */
  cameraTargetHeight: number;
  /** Footprint radius in the ground plane. benilla's `ground_radius`. */
  groundRadius: number;
  /**
   * The direction the figure FACES, as a unit vector in the ground plane of RENDER space.
   *
   * A character `.m2` faces **model +x**, and that is measured rather than assumed: on
   * `HumanMale.m2` attachment 0 (the shield, worn on the LEFT) sits at y = +0.575 and attachment 1
   * (the right hand) at y = -0.476, so +y is the model's own left -- which in a right-handed Z-up
   * frame puts forward at +x. benilla's light rig states the same fact independently ("WoW (0, 1, 0)
   * is the model's own left", `portrait/light.rs:173`).
   *
   * It is carried as a field rather than hardcoded because `scene-rig.ts#modelToRender` is what turns
   * it into render space -- the geometry pipeline bakes a 180-degree yaw into every vertex -- and that
   * conversion belongs to the caller, next to every other value that makes the same trip.
   *
   * The model's own bust CAMERA is deliberately not used for this. It was, in the first version, and
   * the result was a figure in near profile: the artist places that camera at a three-quarter angle
   * on purpose (`HumanMale.m2` camera 0 sits at (0.63, -0.39), 34 degrees off the model's forward),
   * so taking it as "front" adds the artist's portrait angle to the client's own `SetRotation` and
   * the two compound.
   */
  front: readonly [number, number];
  /**
   * The model's own AUTHORED BUST CAMERA, already in render space, or null for a model that ships none.
   *
   * Unused by `bodyFrame` and the whole of `portraitFrame`: the round unit-frame portrait IS the
   * artist's camera, taken verbatim. "The framing is the model's authored portrait camera -- the MD20
   * camera `cameraLookup[0]` selects (VERIFIED) ... and **no** engine-side yaw or normalization on top.
   * Every artist calibrated camera 0 to their own model -- that is the whole mechanism behind the ref's
   * uniformly tight, consistently-angled face crops across humans, wolves, and rabbits"
   * (`benilla/.../portrait/mod.rs:29-41`).
   */
  bust: BustCamera | null;
}

/** A model's authored camera, converted to render space by the caller. */
export interface BustCamera {
  eye: readonly [number, number, number];
  target: readonly [number, number, number];
  /** The authored roll, radians -- rotated about the view axis to make `up`. */
  roll: number;
  /** The client's DIAGONAL opening angle, radians, as the record carries it. */
  fov: number;
  near: number;
  far: number;
}

/** A fitted pane camera: where it stands, what it looks at, and its vertical opening in radians. */
export interface BodyFrame {
  eye: [number, number, number];
  target: [number, number, number];
  /** FULL vertical angle, radians -- what `THREE.PerspectiveCamera.fov` wants (in degrees). */
  fovY: number;
}

/**
 * Fit a camera to a standing figure.
 *
 * `scale` is the look's `CreatureDisplayInfo.scale`, which `applyCharacterLook` has already written
 * into the model's matrix. The anchors are read at scale 1, so the whole rig is multiplied by it --
 * which is algebraically identical to the reference's "bake with root scale reset"
 * (`framing.rs:96-98`) and does not need the model's matrix touched.
 *
 * `aspect` is the pane's own width/height. The horizontal opening follows from it, which is why the
 * width floor divides by it rather than multiplying.
 */
export function bodyFrame(anchors: BodyAnchors, scale: number, aspect: number): BodyFrame {
  const headSignal = Math.max(
    anchors.pivotHeight,
    anchors.cameraTargetHeight,
    anchors.headHeight,
    0.1,
  );
  const top = HEADROOM * headSignal;
  const bottom = -FOOTROOM * headSignal;
  // The vertical window, floored by the footprint: a tauren is wider than it is tall relative to a
  // human, and without this floor its arms leave the frame sideways while its head sits well inside.
  const widthFloor = (2 * WIDTH_MARGIN * anchors.groundRadius) / Math.max(aspect, 0.01);
  const window = Math.max(top - bottom, widthFloor);
  const centre = 0.5 * (top + bottom);

  // The projection's OWN half-angle, so the geometry and the matrix cannot disagree. That is the
  // defect benilla's own comment warns about at framing.rs:265-266.
  const fovY = verticalFov(BODY_FOV, aspect);
  const distance = (0.5 * window) / Math.tan(0.5 * fovY);

  const front = anchors.front;
  // A zero-length facing would put the eye at the target; fall back to a unit vector rather than
  // dividing by nothing.
  const length = Math.hypot(front[0], front[1]) || 1;
  const fx = front[0] / length;
  const fy = front[1] / length;

  const z = centre * scale;
  const d = distance * scale;
  return {
    eye: [fx * d, fy * d, z],
    target: [0, 0, z],
    fovY,
  };
}

/**
 * THE PORTRAIT FRAMING: the model's own camera, verbatim.
 *
 * Not a fit and not a heuristic -- this is the one framing in the booth that is entirely the asset's,
 * and that is the reference's central finding about portraits: the tight, consistently-angled face
 * crop the real client shows for a human, a wolf and a rabbit alike is not an engine rule, it is
 * fifteen thousand artists' camera 0 (`benilla/.../portrait/mod.rs:29-41`, and its own note that this
 * "supersedes the first RE verdict's C4 (framing is not model data)").
 *
 * `up` follows the authored roll about the view axis, which is `glue-scene.ts#aimCamera`'s law with Z
 * standing in for benilla's Y because our scene is Z-up. Where roll is unkeyed or zero -- which
 * benilla's own audit found on every portrait camera it checked -- this is the identity rotation.
 *
 * The FOV is the record's DIAGONAL angle and goes through `verticalFov`, this client's transcription
 * of the projection build (`scene-rig.ts#verticalFov`). benilla reaches the same place by a different
 * road: it hardcodes `0.3 * fov` as the vertical half-angle, which is exactly `verticalFov(fov, 4/3)/2`.
 * At a portrait's own aspect (near 1) the law gives a slightly wider opening than the reference's 4:3
 * specialisation, and the law is what the client does.
 *
 * Returns null for a model with no camera; the caller falls back to `bodyFrame`, which is what benilla
 * does too ("a camera-less model (a few creatures, props) falls back to the heuristic head-anchor
 * framing", `mod.rs:41-42`).
 */
export function portraitFrame(
  anchors: BodyAnchors,
  scale: number,
  aspect: number,
): (BodyFrame & { up: [number, number, number]; near: number; far: number }) | null {
  const bust = anchors.bust;
  if (bust === null) {
    return null;
  }
  const eye: [number, number, number] = [
    bust.eye[0] * scale, bust.eye[1] * scale, bust.eye[2] * scale,
  ];
  const target: [number, number, number] = [
    bust.target[0] * scale, bust.target[1] * scale, bust.target[2] * scale,
  ];

  const fx = target[0] - eye[0];
  const fy = target[1] - eye[1];
  const fz = target[2] - eye[2];
  const up: [number, number, number] = [0, 0, 1];
  const length = Math.hypot(fx, fy, fz);
  if (bust.roll !== 0 && length > 0) {
    // Rodrigues about the unit view axis, on the static up. A degenerate eye===target camera has no
    // axis to roll about, so `up` is left alone rather than fed a zero-length axis -- the same guard
    // `glue-scene.ts#aimCamera` states.
    const ax = fx / length;
    const ay = fy / length;
    const az = fz / length;
    const c = Math.cos(bust.roll);
    const s = Math.sin(bust.roll);
    const dot = az; // up . axis, with up = (0, 0, 1)
    up[0] = ax * dot * (1 - c) + (ay * 1 - az * 0) * s;
    up[1] = ay * dot * (1 - c) + (az * 0 - ax * 1) * s;
    up[2] = c + az * dot * (1 - c);
  }

  return {
    eye,
    target,
    up,
    fovY: verticalFov(bust.fov, aspect),
    // The record's clips, floored the way `glue-scene.ts` floors them: a near plane of 0 is not a
    // plane. `HumanMale.m2` camera 0 carries 0.222 / 27.8, which never clips a model-local bake.
    near: Math.max(bust.near, 0.05),
    far: bust.far,
  };
}
