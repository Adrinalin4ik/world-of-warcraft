import * as THREE from 'three';

import { collisionWorld } from '../collision/collision-world';
import TextureLoader from '../pipeline/texture-loader';
import { DecalFrame, DecalMesh, decalMesh, projectDecal, rectUv } from './decal';
import { selectionColor } from './selection-color';

/**
 * The GROUND SELECTION RING -- the reaction-coloured ellipse the real client draws on the ground under
 * the current target, and the owner's "Кольцо выделения нужно делать. не вижу."
 *
 * IT IS A PROJECTED DECAL, NOT A QUAD. Round 20 declined to ship this and named the reason: the
 * reference's ring is "the actual surface triangles inside the ring's box -- terrain tiles + WMO faces,
 * never doodads -- clipped to the box and textured top-down" (`benilla/src/target/ring.rs:1-11`), so it
 * is coplanar with the visible ground and drapes over steps; a flat quad is wrong on any slope. The
 * projector is `world/decal.ts`, a port of the reference's shared `decal.rs`, and the receiving surfaces
 * are `collisionWorld.terrain` + `collisionWorld.wmo` -- the collector round 20 already named.
 *
 * THE TEXTURE IS THE CLIENT'S OWN, and it was MEASURED off the served file rather than chosen.
 * `textures/unitselecttexture.blp` (`ring.rs:85-87`; served 200 / 175,934 B) decodes as BLP2,
 * `colorEncoding` 1 (palettized) with `alphaSize` 8, 256x256 -- and **every one of its 65,536 texels
 * uses palette entry 0, which is pure white (255,255,255)**. So the file carries no colour at all: the
 * ring's whole appearance is its ALPHA channel, and the colour is the tint this file multiplies in,
 * which is exactly the reference's wiring ("the selector's dword as every vertex's diffuse").
 * Measured alpha, mean 29.78 over the whole square:
 *   - RADIAL (16 buckets to the corner): 0 0 0 4 14 25 35 42 47 63 61 0 0 0 0 0 -- an annulus, empty
 *     inside ~0.19 of the half-width, peaking at ~0.85, and back to zero past ~0.97. That is why the
 *     projection box's half-extent is the ring radius exactly: the texture square IS the ring's extent.
 *   - ANGULAR (12 sectors around the ring band): 63 95 112 111 94 62 25 1 0 0 1 25 -- so the fade the
 *     reference describes is real and baked in: a bright arc on one side, a tail that reaches ZERO on
 *     the other. Left unoriented it would read as a fixed gap on one world side, which is why
 *     `fadeAngle` below turns it.
 *
 * THE COLOUR RULE is `world/selection-color.ts`, the selector `UnitSelectionColor` already answers
 * from -- one law, one function. A neutral Northshire wolf is rank 3 = YELLOW, which is what the
 * owner's own reference crop shows.
 *
 * THE FRAME BUDGET. This costs the UI draw fingerprint exactly NOTHING, and by construction rather
 * than by measurement: the ring is world geometry in the world scene, drawn by
 * `renderer.render(world.scene, camera)`. `drawListSignature` mixes UI draw items and cannot see it, so
 * the offscreen-target saving `world-ui.ts` exists for is untouched. Its own cost is one draw call plus
 * a re-projection, and the re-projection is gated on `RingKey` -- the reference's own rebuild gate
 * (`ring.rs:71-77`): a still target under a still camera pays a compare.
 */

/** `textures/unitselecttexture.blp` -- the reference's own ring texture (`ring.rs:87`). */
const RING_TEXTURE = 'textures\\unitselecttexture.blp';

/**
 * Model-local ring radius for a unit whose M2 has not landed (or authors a degenerate box).
 * `ring.rs:89` -- a unit with no model has no footprint to read.
 */
const FALLBACK_RADIUS = 0.7;

/**
 * Floor on the model-local radius. `ring.rs:327`'s 0.05: it only stops a zero-bounds model rendering an
 * invisible ring; a real model always uses its own footprint however small.
 */
const MIN_LOCAL_RADIUS = 0.05;

/**
 * Emitted-vertex budget. A ring box is ~2-4 yd across, which is at most a few terrain cells (cell size
 * 33.33/8 = 4.17 yd, 4 triangles each) but can be a dense WMO floor. 4096 vertices is 1365 triangles,
 * far above anything measured, and `projectDecal` degrades to a partial ring rather than nothing if a
 * pathological floor ever exceeds it.
 */
const MAX_VERTICES = 4096;

/**
 * The projection's rebuild inputs (`ring.rs:71-77`, the reference's own `RingKey`). Compared exactly,
 * not with an epsilon: a unit standing still reports a bit-identical position, and a moving one has to
 * re-project anyway.
 */
interface RingKey {
  x: number;
  y: number;
  z: number;
  radius: number;
  fadeAngle: number;
  /** Provider sizes, so a tile streaming in under a standing target re-projects. */
  surfaces: number;
}

/** What a ring needs to know about its target. Deliberately not a `Unit`, so this is testable. */
export interface RingTarget {
  position: THREE.Vector3;
  /** `UnitReaction`'s 1..8 scale. */
  reaction: number;
  isPlayer: boolean;
  dead: boolean;
  /** `M2#ringFootprint` x `OBJECT_FIELD_SCALE_X`, or null when there is no model yet. */
  worldRadius: number | null;
}

const VERTEX_SHADER = `
attribute float fade;
varying vec2 vUv;
varying float vFade;
void main() {
  vUv = uv;
  vFade = fade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * The ring is ADDITIVE and writes NO destination alpha.
 *
 * The colour is `tint * vertexFade * textureAlpha` -- the texture's RGB is discarded because it is
 * uniformly white (measured, see the file header), so sampling it would be a multiply by one. Emitting
 * the product PREMULTIPLIED and blending `(ONE, ONE)` is what makes an additive tint correct; emitting
 * an un-premultiplied colour with an additive blend would glow over the whole square.
 *
 * `gl_FragColor.a` is 0 and the alpha blend factors are `(ZERO, ONE)` -- CLAUDE.md's ADD trap. The world
 * pass draws straight to the canvas rather than into an alpha-carrying target, so nothing here depends
 * on that; it is explicit so the ring cannot become the next thing that saturates a target's alpha if a
 * post pass is ever added.
 */
const FRAGMENT_SHADER = `
uniform sampler2D ringTexture;
uniform vec3 tint;
uniform float debugSolid;
varying vec2 vUv;
varying float vFade;
void main() {
  float a = texture2D(ringTexture, vUv).a * vFade;
  // THE DIAGNOSTIC ARM (window.worldRingDebug = true, which also switches the depth test off): paint the
  // whole clipped polygon opaque instead of the ring's own alpha. "The instrument says 12 triangles and the
  // screen shows nothing" has three possible causes -- not drawn, drawn and occluded, drawn and too faint
  // -- and only a solid patch with no depth test separates them. It changes nothing on the normal path.
  // NO BACKTICKS IN THIS SHADER: it is a JS template literal and one would terminate the string, which is
  // CLAUDE.md's lua/compat.ts trap in a second place. Caught by tsc, with two nonsense errors pointing here.
  a = mix(a, 1.0, debugSolid);
  gl_FragColor = vec4(tint * a, 0.0);
}
`;

export class SelectionRing {
  private readonly mesh: THREE.Mesh;

  private readonly material: THREE.ShaderMaterial;

  private readonly geometry: THREE.BufferGeometry;

  private readonly decal: DecalMesh = decalMesh(MAX_VERTICES);

  private readonly frame: DecalFrame = {
    centre: new THREE.Vector3(),
    sin: 0,
    cos: 1,
    minX: -1,
    maxX: 1,
    minY: -1,
    maxY: 1,
    minZ: -2,
    maxZ: 2,
  };

  private key: RingKey | null = null;

  /**
   * Last frame's fade angle, kept so a camera looking straight down (degenerate horizontal direction)
   * HOLDS the previous orientation instead of snapping to an arbitrary one -- `ring.rs:269-271`.
   */
  private fadeAngle = 0;

  private textureLoaded = false;

  /** Whether the diagnostic arm is currently armed -- see `FRAGMENT_SHADER`'s `debugSolid`. */
  private debugging = false;

  /** Instrument: what the last projection did. Read through `window.worldRing`. */
  readonly stats = {
    shown: false,
    vertices: 0,
    triangles: 0,
    radius: 0,
    reaction: 0,
    tint: [0, 0, 0] as number[],
    fadeAngle: 0,
    /** Projections actually performed, against `frames` -- the rebuild gate's own measurement. */
    projections: 0,
    frames: 0,
    projectMs: 0,
    /** True when the box found no receiving surface: the reference's no-ground gate fired. */
    noGround: false,
    textureLoaded: false,
  };

  constructor(scene: THREE.Scene) {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.decal.positions, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.decal.uvs, 2));
    this.geometry.setAttribute('fade', new THREE.BufferAttribute(this.decal.fades, 1));
    // The vertices are already world-space, so the mesh's own transform must stay identity and its
    // bounds must never be used to cull it -- the buffers are rewritten under three's feet.
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        ringTexture: { value: TextureLoader.PLACEHOLDER },
        tint: { value: new THREE.Vector3(1, 1, 0) },
        debugSolid: { value: 0 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      // COPLANARITY. The projected vertices rest exactly on the drawn ground, so with no bias the depth
      // test dissolves into per-pixel float noise -- stipple and view-dependent bites out of the ring.
      // The reference fights the same thing with polygon offset (`ring.rs:93-98`, trace-verified as the
      // fixed-function twin of its rasterizer depth bias), which is precisely what these three do.
      // A geometric lift was NOT used: `ring.rs` records 0.1 and 0.02 both reading as hovering at
      // grazing angles.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
      // The clipped triangles keep whatever winding the source surface had, and a WMO floor and a
      // terrain cell do not agree on it. Culling would drop half the ring.
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'SelectionRing';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    // Over the ground, under nothing: the ring is the top ground decal in the reference's ordering
    // (`ring.rs:519` pushes it at "the ring rung ... over the blob shadows"). `renderOrder` only
    // matters against other transparent world draws; depth still decides against opaque geometry.
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    scene.add(this.mesh);

    // CLAMP on both axes. Every emitted UV is already inside `[0,1]` (the clip frame IS the texture
    // frame), so wrapping could only bite through bilinear filtering at the exact border -- where the
    // measured alpha is 0 anyway. Clamping states the intent rather than relying on that.
    // The `as never` casts are `texture-loader.js` being untyped: its defaults make TypeScript infer the
    // literal type `1000` (`RepeatWrapping`) for both parameters.
    TextureLoader.load(
      RING_TEXTURE,
      THREE.ClampToEdgeWrapping as never,
      THREE.ClampToEdgeWrapping as never,
    )
      .then((texture: THREE.Texture) => {
        this.material.uniforms.ringTexture.value = texture;
        this.textureLoaded = true;
        this.stats.textureLoaded = true;
      })
      .catch((error: unknown) => {
        // Declared, not swallowed: with no texture the ring is invisible, and a silent invisible ring is
        // indistinguishable from the feature not existing.
        console.error(`SelectionRing: ${RING_TEXTURE} failed to load, no ring will draw:`, error);
      });
  }

  /**
   * One frame. `target` is null when nothing is selected.
   *
   * Called from `World#animate` AFTER the entity pass, so the target's `position` is this frame's.
   */
  update(target: RingTarget | null, camera: THREE.Camera): void {
    this.stats.frames += 1;
    // THE SAME-BUILD CONTROL ARM (`window.worldRingEnabled = false`), the shape `window.uiTextSnap` and
    // `window.worldPickNarrow` use. A ring claim cannot be checked across two builds -- the mobs wander
    // and the ground under them changes -- so an A/B needs one build and a switch.
    if ((window as never as Record<string, unknown>).worldRingEnabled === false) {
      this.hide();
      return;
    }
    if (target === null || !this.textureLoaded) {
      this.hide();
      return;
    }

    const local = Math.max(target.worldRadius ?? FALLBACK_RADIUS, MIN_LOCAL_RADIUS);
    const feet = target.position;
    const fadeAngle = this.fadeAngleFor(feet, camera);
    const surfaces = surfaceCount();

    const key: RingKey = {
      x: feet.x,
      y: feet.y,
      z: feet.z,
      radius: local,
      fadeAngle,
      surfaces,
    };

    let projected = this.decal.count > 0;
    if (this.key === null || !sameKey(this.key, key)) {
      const started = performance.now();
      projected = this.project(feet, local, fadeAngle);
      this.stats.projectMs = performance.now() - started;
      this.stats.projections += 1;
      this.key = key;
      this.upload();
    }

    const [r, g, b] = selectionColor(target.reaction, target.isPlayer, target.dead);
    (this.material.uniforms.tint.value as THREE.Vector3).set(r, g, b);

    const debug = (window as never as Record<string, unknown>).worldRingDebug === true;
    if (debug !== this.debugging) {
      this.debugging = debug;
      this.material.uniforms.debugSolid.value = debug ? 1 : 0;
      this.material.depthTest = !debug;
      this.material.needsUpdate = true;
    }

    this.stats.radius = local;
    this.stats.reaction = target.reaction;
    this.stats.tint = [r, g, b];
    this.stats.fadeAngle = fadeAngle;
    this.stats.noGround = !projected;
    this.stats.vertices = this.decal.count;
    this.stats.triangles = this.decal.count / 3;
    // The reference's no-ground gate: nothing received the projection (mid-air, an unstreamed tile), so
    // the whole draw is skipped rather than drawn somewhere wrong.
    this.mesh.visible = projected;
    this.stats.shown = projected;
  }

  /**
   * The ring fade's angle: the texture's BRIGHT arc faces the camera and its transparent tail points
   * away -- the reference decal's behaviour (`ring.rs:432-449`), whose projector transform is camera-fed.
   *
   * DERIVED HERE FROM OUR OWN TWO FACTS, because the reference's formula is for a Y-up engine and a
   * different UV convention. (1) The bright side of `unitselecttexture.blp` is the image's BOTTOM row
   * band -- measured, see the file header's angular profile, taken in image coordinates with +y
   * downward. (2) `TextureLoader` creates every texture with `flipY = false`
   * (`pipeline/texture-loader.js:26-28`), so `v = 0` samples the FIRST row of file data, the image's top,
   * and `v = 1` samples the bottom. So the bright side is at `v = 1`, which `rectUv` places at the
   * frame's +Y edge.
   *
   * `inFrame` maps a world offset `d` to `R(theta) . d`, so requiring the camera direction `c` to land
   * on the frame's +Y axis gives `R(theta) . c = (0, 1)`, i.e. `theta = PI/2 - atan2(c.y, c.x)`.
   *
   * Returns the previous angle when the camera is directly overhead.
   */
  private fadeAngleFor(feet: THREE.Vector3, camera: THREE.Camera): number {
    const dx = camera.position.x - feet.x;
    const dy = camera.position.y - feet.y;
    if (dx * dx + dy * dy < 1e-6) {
      return this.fadeAngle;
    }
    this.fadeAngle = Math.PI / 2 - Math.atan2(dy, dx);
    return this.fadeAngle;
  }

  /**
   * Rebuild the projection. The box is the ROTATED texture square (half-extent = the radius, so the clip
   * frame is exactly the texture frame and UVs stay in `[0,1]`) x a vertical half-range of **2 x radius**
   * -- `ring.rs:451-492`, the byte-verified `center +- s` horizontal, `center +- 2s` vertical (`0x608e00`).
   *
   * The vertical fade is the reference's own trapezoid: full within +-0.5r of the feet, ramping to 0 at
   * the box's +-2r, so a smear up a wall or down a ledge dims with height instead of ending in a hard clip
   * line. Its exact profile is INTERIM in the reference too -- the client's edge-fade alpha grid
   * (`0x6147f0`) is byte-located but its ramp is unrecorded -- and it is carried here unchanged rather
   * than re-invented.
   */
  private project(feet: THREE.Vector3, radius: number, fadeAngle: number): boolean {
    const frame = this.frame;
    frame.centre.copy(feet);
    frame.sin = Math.sin(fadeAngle);
    frame.cos = Math.cos(fadeAngle);
    frame.minX = -radius;
    frame.maxX = radius;
    frame.minY = -radius;
    frame.maxY = radius;
    const vertical = 2 * radius;
    frame.minZ = -vertical;
    frame.maxZ = vertical;

    return projectDecal(
      this.decal,
      frame,
      (_x, _y, dz) => Math.min(1, Math.max(0, (vertical - Math.abs(dz)) / (1.5 * radius))),
      (x, y) => rectUv(frame, x, y),
    );
  }

  private upload(): void {
    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const uv = this.geometry.getAttribute('uv') as THREE.BufferAttribute;
    const fade = this.geometry.getAttribute('fade') as THREE.BufferAttribute;
    position.needsUpdate = true;
    uv.needsUpdate = true;
    fade.needsUpdate = true;
    this.geometry.setDrawRange(0, this.decal.count);
  }

  private hide(): void {
    this.mesh.visible = false;
    this.stats.shown = false;
    this.stats.vertices = 0;
    this.stats.triangles = 0;
    this.stats.noGround = false;
    // Drop the key so re-selecting the same unit at the same spot re-projects rather than trusting a
    // slice built who-knows-when: a tile can have streamed out in between.
    this.key = null;
    this.decal.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  /**
   * THE GATE'S INSTRUMENT: the world-space positions the projection actually emitted, as `[x, y, z]`
   * triples.
   *
   * A crop cannot answer "does the ring follow the slope" -- this project has had a crop hide a real
   * 28-unit overrun and nearly produce a false clipping report. What answers it is comparing these
   * vertices against an INDEPENDENT oracle for the ground height, which
   * `collisionWorld.terrain.heightAt` is: it is the heightmap read movement uses and it shares no code
   * with `projectDecal`'s clip. Deliberately raw positions and no residual computed here -- an
   * instrument that carries its own copy of the rule confirms whatever the rule already believed.
   */
  vertices(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < this.decal.count; ++i) {
      out.push([this.decal.positions[i * 3], this.decal.positions[i * 3 + 1], this.decal.positions[i * 3 + 2]]);
    }
    return out;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

function sameKey(a: RingKey, b: RingKey): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.z === b.z &&
    a.radius === b.radius &&
    a.fadeAngle === b.fadeAngle &&
    a.surfaces === b.surfaces
  );
}

/**
 * Registered receiving-surface count -- the `RingKey`'s streaming term, so a tile arriving under a
 * standing target re-projects instead of holding a slice built before the ground existed.
 */
function surfaceCount(): number {
  return collisionWorld.terrain.size + collisionWorld.wmo.size;
}
