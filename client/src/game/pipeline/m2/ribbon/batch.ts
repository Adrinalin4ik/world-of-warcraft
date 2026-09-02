import * as THREE from 'three';

import TextureLoader from '../../texture-loader';
import { applyBlendingModeToMaterial } from '../material';
import { RibbonRuntime } from './runtime';

/**
 * ONE RIBBON'S DRAW -- a world-space triangle strip, and the material that paints it.
 *
 * ## It is NOT the particle batch, and it must not be
 *
 * `ParticleBatch` is instanced: one unit quad, per-instance offset/scale/rotation, and a vertex shader
 * that rebuilds every quad in VIEW space so it faces the camera (`particle/shader.vert`). A ribbon
 * segment is the opposite -- a quad spanning two committed edges in WORLD space, whose orientation is
 * the trail's, not the viewer's. Billboarding it would turn a lightning bolt into a sheet that swings
 * as the player walks, which is this project's three-times-recorded failure mode.
 *
 * So the geometry is its own, but **the buffer discipline is copied rather than reinvented**: typed
 * arrays sized once at construction from the runtime's ring capacity, `drawRange` set per frame,
 * bounded update ranges on the attributes, and `frustumCulled = false` for the same reason
 * `ParticleBatch` sets it -- the vertices move every frame and three's bounding sphere is computed from
 * the base attribute, so leaving culling on would drop the strip whenever the object origin left the
 * frustum.
 *
 * ## The blend comes from the M2 render-flags table, so it uses the M2 helper
 *
 * A ribbon's `materialIndices` point at the M2 render-flags table -- "the M2 render-flags table
 * @MD20+0x84, stride 4: flags u16 + blend u16 -- the blend source"
 * (`benilla-formats/src/ribbons.rs:14-16`), which this client parses as `m2.materials`
 * (`wow-data-parser/m2/index.js:71-74`, `{ renderFlags, blendingMode }`).
 *
 * That provenance decides which of the two blend helpers to use, and it is not a preference:
 * `applyBlendingModeToMaterial` (`m2/material/index.ts`) is the one that reads a `blendingMode` from
 * that same table, and it is also the one that **pins the separate alpha factors** so a draw never
 * writes the framebuffer's alpha channel -- the fix its docstring traces to `d348889` and to the
 * premultiplied-alpha canvas. `particle/material.ts#applyParticleBlending` sets only `blendSrc`/
 * `blendDst` and leaves the alpha pair alone, despite its own comment saying the two "must blend
 * identically"; that inconsistency is REPORTED rather than fixed here, because changing the particle
 * blend is a visible change to a lane the owner is actively judging.
 *
 * `depthWrite` is off and `depthTest` is left at three's default (on), matching the particle path: a
 * trail is unsorted and semi-transparent, so writing depth would let one segment occlude the next.
 */

/** Bytes per vertex attribute set: position(3) + uv(2) + colour(4). */
const FLOATS_POSITION = 3;
const FLOATS_UV = 2;
const FLOATS_COLOR = 4;

const vertexShader = `
precision highp float;

attribute vec4 aColor;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  vUv = uv;
  vColor = aColor;
  // NO BACKTICKS IN THIS SHADER SOURCE: it is a JS template literal, and one backtick-quoted
  // identifier in a comment terminates the string -- the same trap CLAUDE.md records for
  // lua/compat.ts, which cost ~25 nonsense TS errors pointing at the wrong language.
  //
  // The position attribute is already WORLD space: the runtime commits edge vertices through the
  // bone's world matrix. So this uses viewMatrix and NOT modelViewMatrix -- the batch's own object
  // transform must not be applied a second time, and the batch sits at the identity for that reason.
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
precision highp float;

uniform sampler2D texture_sampler;
uniform vec4 tint;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec4 texel = texture2D(texture_sampler, vUv);
  gl_FragColor = texel * vColor * tint;
}
`;

/**
 * The material for one ribbon. Owns its texture handle and never touches a shared one -- a ribbon
 * material is built per (instance, ribbon) pair, so nothing here is shared and `ownsBatches` has no
 * bearing; the rule it protects (never write a material another placement is drawing) is satisfied by
 * construction.
 */
export class RibbonMaterial extends THREE.ShaderMaterial {
  private resolvedTexture: THREE.Texture | null = null;

  private disposed = false;

  /** Settles when the texture load finishes, successfully or not. Never rejects. */
  readonly ready: Promise<void>;

  constructor(texturePath: string, blendingMode: number) {
    super();

    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;
    this.uniforms = {
      texture_sampler: { value: TextureLoader.PLACEHOLDER },
      tint: { value: new THREE.Vector4(1, 1, 1, 1) },
    };

    // A strip is viewed from both sides as it curls, exactly as a billboard is.
    this.side = THREE.DoubleSide;
    // Unsorted and semi-transparent: writing depth would let one segment occlude the next.
    this.depthWrite = false;

    // From the M2 render-flags table -- see the file header for why this helper and not the particle
    // one. It pins the separate alpha factors so the draw never writes framebuffer alpha.
    applyBlendingModeToMaterial(this, blendingMode);

    this.ready = TextureLoader.load(texturePath)
      .then((texture: THREE.Texture) => {
        if (this.disposed) {
          TextureLoader.unload(texture);
          return;
        }
        this.resolvedTexture = texture;
        this.uniforms.texture_sampler.value = texture;
      })
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`Failed to load ribbon texture ${texturePath}:`, error);
      });
  }

  dispose(): void {
    super.dispose();
    this.disposed = true;
    if (this.resolvedTexture !== null) {
      TextureLoader.unload(this.resolvedTexture);
      this.resolvedTexture = null;
    }
  }
}

/** The drawable strip for one ribbon runtime. */
export class RibbonBatch extends THREE.Mesh {
  private positions: Float32Array;

  private uvs: Float32Array;

  private colors: Float32Array;

  private readonly maxEdges: number;

  private readonly tint = {
    r: 1, g: 1, b: 1, a: 1,
  };

  constructor(material: RibbonMaterial, maxEdges: number) {
    const geometry = new THREE.BufferGeometry();

    // Two vertices per edge, and the strip is drawn as independent quads (two triangles per segment)
    // rather than a real TRIANGLE_STRIP: an indexed quad list needs no degenerate joins and lets the
    // draw range be a clean multiple of six, which is what makes the per-frame update a `drawRange`
    // write instead of a geometry rebuild.
    const vertexCount = maxEdges * 2;
    const positions = new Float32Array(vertexCount * FLOATS_POSITION);
    const uvs = new Float32Array(vertexCount * FLOATS_UV);
    const colors = new Float32Array(vertexCount * FLOATS_COLOR);

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, FLOATS_POSITION));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, FLOATS_UV));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, FLOATS_COLOR));

    // The index pattern is FIXED for the life of the batch -- segment i joins edge i to edge i+1 --
    // so it is built once and only `drawRange` moves per frame.
    const indices: number[] = [];
    for (let segment = 0; segment < maxEdges - 1; segment += 1) {
      const a = segment * 2;
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);

    super(geometry, material);

    this.positions = positions;
    this.uvs = uvs;
    this.colors = colors;
    this.maxEdges = maxEdges;

    // The vertices are world space and move every frame, so three's bounding sphere -- computed from
    // the base attribute -- says nothing useful. Same reason `ParticleBatch` sets this.
    this.frustumCulled = false;
    this.matrixAutoUpdate = false;
    this.visible = false;
  }

  /**
   * Rewrite the strip from a runtime's committed edges. Returns the number of segments drawn.
   *
   * Writes only the live prefix and bounds the upload to it, exactly as `ParticleBatch#pack` does --
   * no allocation, no geometry rebuild, and an untouched tail of the buffers.
   */
  pack(runtime: RibbonRuntime): number {
    const geometry = this.geometry as THREE.BufferGeometry;

    if (runtime.live < 2) {
      geometry.setDrawRange(0, 0);
      this.visible = false;
      return 0;
    }

    runtime.sampleTint(this.tint);
    (this.material as RibbonMaterial).uniforms.tint.value.set(
      this.tint.r, this.tint.g, this.tint.b, this.tint.a,
    );

    let index = 0;
    runtime.forEachEdge((edge, ageFraction) => {
      if (index >= this.maxEdges) {
        return;
      }
      const v = index * 2;

      this.positions[v * FLOATS_POSITION] = edge.ax;
      this.positions[v * FLOATS_POSITION + 1] = edge.ay;
      this.positions[v * FLOATS_POSITION + 2] = edge.az;
      this.positions[(v + 1) * FLOATS_POSITION] = edge.bx;
      this.positions[(v + 1) * FLOATS_POSITION + 1] = edge.by;
      this.positions[(v + 1) * FLOATS_POSITION + 2] = edge.bz;

      // `u` slides with edge AGE -- the head at 0, the tail at 1 -- which is what makes the texture's
      // transparent tail fade the trail (`benilla-world/src/ribbons.rs:3-8`). `v` spans the strip.
      this.uvs[v * FLOATS_UV] = ageFraction;
      this.uvs[v * FLOATS_UV + 1] = 0;
      this.uvs[(v + 1) * FLOATS_UV] = ageFraction;
      this.uvs[(v + 1) * FLOATS_UV + 1] = 1;

      // The per-vertex colour is white here: the whole-strip tint rides the uniform above, so the
      // vertex attribute is left as the identity rather than multiplied twice.
      for (let k = 0; k < 2; k += 1) {
        const c = (v + k) * FLOATS_COLOR;
        this.colors[c] = 1;
        this.colors[c + 1] = 1;
        this.colors[c + 2] = 1;
        this.colors[c + 3] = 1;
      }

      index += 1;
    });

    const segments = Math.max(0, index - 1);
    geometry.setDrawRange(0, segments * 6);
    this.visible = segments > 0;

    for (const name of ['position', 'uv', 'aColor']) {
      const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
      attribute.clearUpdateRanges();
      if (index > 0) {
        attribute.addUpdateRange(0, index * 2 * attribute.itemSize);
      }
      attribute.needsUpdate = true;
    }

    return segments;
  }

  disposeBatch(): void {
    (this.geometry as THREE.BufferGeometry).dispose();
    (this.material as RibbonMaterial).dispose();
  }
}

export default RibbonBatch;
