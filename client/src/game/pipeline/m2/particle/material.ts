import * as THREE from 'three';

import TextureLoader from '../../texture-loader';
import fragmentShader from './shader.frag';
import vertexShader from './shader.vert';

/**
 * M2Particle.blendingType. Same numbering as the M2 material blend modes, and the factor pairs below
 * mirror `applyBlendingMode` in `client/src/game/pipeline/m2/material/index.ts` deliberately -- particles
 * and batches must blend identically or the same texture reads differently in each.
 */
export const PARTICLE_BLEND_MODE = {
  OPAQUE: 0,
  ALPHA_KEY: 1,
  ALPHA: 2,
  ADD: 3,
  ADD_ALPHA: 4,
  MODULATE: 5,
  MODULATE_2X: 6,
};

export const applyParticleBlending = (material: any, blendingType: number): void => {
  if (blendingType === PARTICLE_BLEND_MODE.OPAQUE) {
    material.blending = THREE.NoBlending;
    material.transparent = false;
    material.depthWrite = true;
    return;
  }

  // Particles never write depth: they are unsorted and semi-transparent, so depth writes would let
  // whichever particle drew first occlude the ones behind it.
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;

  switch (blendingType) {
    case PARTICLE_BLEND_MODE.ALPHA_KEY:
      material.alphaTest = 0.5;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.ZeroFactor;
      break;

    case PARTICLE_BLEND_MODE.ADD:
      material.blendSrc = THREE.SrcColorFactor;
      material.blendDst = THREE.DstColorFactor;
      break;

    case PARTICLE_BLEND_MODE.ADD_ALPHA:
      material.blendSrc = THREE.SrcAlphaFactor;
      material.blendDst = THREE.OneFactor;
      break;

    case PARTICLE_BLEND_MODE.MODULATE:
      material.blendSrc = THREE.DstColorFactor;
      material.blendDst = THREE.ZeroFactor;
      break;

    case PARTICLE_BLEND_MODE.MODULATE_2X:
      material.blendSrc = THREE.DstColorFactor;
      material.blendDst = THREE.SrcColorFactor;
      break;

    case PARTICLE_BLEND_MODE.ALPHA:
    default:
      // Alpha blending is the safe fallback for an unrecognised mode: it shows the particle rather than
      // dropping it, which makes a bad mode visible instead of silently invisible.
      material.blendSrc = THREE.SrcAlphaFactor;
      material.blendDst = THREE.OneMinusSrcAlphaFactor;
      break;
  }
};

export class ParticleMaterial extends THREE.ShaderMaterial {

  readonly blendingType: number;

  private resolvedTexture: THREE.Texture | null = null;
  private disposed = false;

  /**
   * THE READINESS HANDLE: resolves when this material's texture load has SETTLED, successfully or not.
   *
   * It exists because the constructor starts I/O, and a caller that constructs one inside a `.then`
   * handler otherwise creates a promise nothing can return -- which is what Bluebird reports as
   * "a promise was created in a handler ... but was not returned from it". `ParticleManager#ready`
   * aggregates these so its callers can return the chain instead of orphaning it.
   *
   * **It NEVER REJECTS, and that is load-bearing rather than lazy.** The two doodad lanes register
   * from a `.then` with no `.catch` of their own (`world/doodad-manager.js#loadDoodad`,
   * `pipeline/wmo/index.js#processLoadDoodad`), so a rejecting handle returned into those chains would
   * turn a missing particle texture into an unhandled rejection -- the exact class of problem this
   * change is meant to remove. The failure is already reported by the `.catch` below; this handle
   * answers "has it finished trying", not "did it work".
   */
  readonly ready: Promise<void>;

  constructor(texturePath: string, blendingType: number) {
    super();

    this.blendingType = blendingType;

    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    // The fragment shader's fog branch is compiled per blend mode, exactly as the M2 materials do it,
    // so an additive particle fades toward black while an alpha-blended one fades toward fog colour.
    this.defines = { BLENDING_MODE: blendingType };

    this.uniforms = {
      texture_sampler: { value: TextureLoader.PLACEHOLDER },
      // Only mode 1 (ALPHA_KEY) turns this on. `this.alphaTest = 0.5` below is kept too -- it is
      // harmless and keeps the material-level test meaningful -- but it does not itself discard
      // anything on a ShaderMaterial with a hand-written fragment shader; `alphaKey` is what the
      // shader actually reads to do the cut. See shader.frag.
      alphaKey: { value: blendingType === PARTICLE_BLEND_MODE.ALPHA_KEY ? 1.0 : 0.0 },

      // Refreshed each frame from MapLight by ParticleManager. The defaults are a no-op ramp: with
      // fogParams.y = 1 the factor is zero at every distance, so a material that never receives an
      // update renders exactly as it did before fog existed rather than turning solid fog colour.
      fogParams: { value: new THREE.Vector4(0.0, 1.0, 1.0, 1.0) },
      fogColor: { value: new THREE.Color(0, 0, 0) },

      // The interior fog triple and its selector, refreshed each frame by ParticleManager from the
      // owning M2 instance's `perObjectLighting.interiorFog`. See shader.frag's `applyFog`.
      wmoFogParams: { value: new THREE.Vector4(0.0, 1.0, 1.0, 1.0) },
      wmoFogColor: { value: new THREE.Color(0, 0, 0) },
      interiorFog: { value: 0.0 },
    };

    // Both faces: a billboarded quad's winding depends on the camera, and culling it would make
    // particles vanish from half the angles a player can stand at.
    this.side = THREE.DoubleSide;

    // `depthTest` IS DELIBERATELY LEFT AT THREE'S DEFAULT (true), and a depth bias is NOT the answer
    // to a particle that reads as being behind something it should be in front of.
    //
    // The owner reported an effect partly occluded by a rock far behind the character. Worked through
    // rather than patched: `shader.vert` builds the quad in VIEW space (`viewCenter.xy += spun`), so a
    // billboard has exactly ONE depth -- its centre's -- and the corner offset cannot perturb it. An
    // opaque rock is `blendingMode` 0, which leaves `transparent` false and `depthWrite` true
    // (`m2/material/index.ts:505-519`), so it writes correct depth in the opaque pass and a NEARER
    // particle passes `depthTest` and draws over it.
    //
    // So for a far rock to occlude these, the particle centres must genuinely BE farther than the rock
    // -- a world-POSITION defect, not a depth one. Disabling `depthTest` or biasing depth would hide
    // that by drawing particles over everything, and `CLAUDE.md`'s record is that every orientation
    // defect here was two conventions meeting and none was fixed by negating a coordinate.
    // `window.worldSpellFx()` reports each live effect's `distFromPlayer` for exactly this reason: a
    // hand effect should be a couple of units away, not tens.

    applyParticleBlending(this, blendingType);

    this.ready = TextureLoader.load(texturePath)
      .then((texture) => {
        if (this.disposed) {
          // The material was disposed before the texture arrived: release it immediately rather than
          // pinning a reference nothing will ever use or unload.
          TextureLoader.unload(texture);
          return;
        }

        this.resolvedTexture = texture;
        this.uniforms.texture_sampler.value = texture;
      })
      .catch((error) => {
        console.error(`Failed to load particle texture ${texturePath}:`, error);
      });
    // `.catch` above returns a resolved promise, so `ready` settles either way -- see its docstring.
  }

  dispose() {
    super.dispose();

    this.disposed = true;

    if (this.resolvedTexture) {
      TextureLoader.unload(this.resolvedTexture);
      this.resolvedTexture = null;
    }
  }

}
