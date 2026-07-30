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

  constructor(texturePath: string, blendingType: number) {
    super();

    this.blendingType = blendingType;

    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    this.uniforms = {
      texture_sampler: { value: TextureLoader.PLACEHOLDER },
    };

    // Both faces: a billboarded quad's winding depends on the camera, and culling it would make
    // particles vanish from half the angles a player can stand at.
    this.side = THREE.DoubleSide;

    applyParticleBlending(this, blendingType);

    TextureLoader.load(texturePath)
      .then((texture) => {
        this.uniforms.texture_sampler.value = texture;
      })
      .catch((error) => {
        console.error(`Failed to load particle texture ${texturePath}:`, error);
      });
  }

}
