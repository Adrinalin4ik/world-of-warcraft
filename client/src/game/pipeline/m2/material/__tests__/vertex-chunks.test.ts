/**
 * @jest-environment node
 */
import * as THREE from 'three';

import commonHeader from '../vertex/common-header.glsl';
import commonMain from '../vertex/common-main.glsl';

/**
 * GLSL cannot be unit-tested by running it, so this guards the one invariant of the vertex chunk that
 * is silent when broken: BOTH branches of the `USE_SKINNING` #ifdef must hand the fragment stage a
 * WORLD-space normal.
 *
 * The fragment stage's consumers are world space -- `sunParams.xyz` in `m2SunLobe`, and
 * `wmoLightPosition` in `applyWmoPointLights`. A skinned branch that omits `modelMatrix` leaves the
 * normal in model space instead, and nothing anywhere reports it: the model still draws, still
 * projects to the right pixels, still samples the right texture. It is simply lit from the wrong
 * direction, and for a unit -- whose model carries `rotation.z = PI` plus the body heading -- that is
 * a whole yaw of error, which at night puts every fragment near the lobe's minimum.
 */
/**
 * Comments stripped: these guards ban IDENTIFIERS from the code, and the comment explaining why they
 * are banned necessarily names them.
 */
const codeOf = (source: string) => source.replace(/\/\/.*$/gm, '');

describe('M2 vertex common-main', () => {
  /** The `worldVertexNormal` assignments, one per #ifdef branch. */
  const normalAssignments = codeOf(commonMain)
    .split('\n')
    .filter((line: string) => /^\s*worldVertexNormal\s*=/.test(line));

  it('assigns the normal varying in exactly two branches', () => {
    expect(normalAssignments).toHaveLength(2);
  });

  it('takes the normal to WORLD space in both branches', () => {
    for (const line of normalAssignments) {
      expect(line).toMatch(/modelMatrix/);
    }
  });

  it('composes the skin with modelMatrix, since bone matrices land in model space', () => {
    const skinned = normalAssignments.find((line: string) => line.includes('skinMatrix'));

    expect(skinned).toBeDefined();
    expect(skinned).toMatch(/modelMatrix\s*\*\s*skinMatrix/);
  });

  it('gets getBoneMatrix from three rather than hand-rolling it', () => {
    // The hand-rolled version read `boneTextureWidth` / `boneTextureHeight`, which three does not
    // supply -- it derives the size in GLSL. Uniforms nothing uploads read as ZERO, so `mod(j, 0.0)`
    // gave NaN, every bone matrix came back NaN, gl_Position with it, and the GPU discarded every
    // vertex. Silently: it compiled, it linked, `onAfterRender` still fired, and every uniform still
    // read correct from JS because none of them reached the shader.
    const code = codeOf(commonHeader);

    expect(code).toMatch(/#include <skinning_pars_vertex>/);
    expect(code).not.toMatch(/boneTextureWidth|boneTextureHeight|boneTextureSize/);
    expect(code).not.toMatch(/boneGlobalMatrices/);
    expect(code).not.toMatch(/mat4 getBoneMatrix/);
  });

  it('uses a chunk that really does define getBoneMatrix in the installed three', () => {
    // Guards the include NAME against a three upgrade renaming or splitting the chunk: an unknown
    // include resolves to nothing, and the failure would look exactly like the one above.
    const chunk = (THREE as any).ShaderChunk.skinning_pars_vertex;

    expect(chunk).toBeDefined();
    expect(chunk).toMatch(/mat4 getBoneMatrix/);
    expect(chunk).toMatch(/bindMatrixInverse/);
  });

  it('calls getBoneMatrix for all four skin indices', () => {
    for (const component of ['x', 'y', 'z', 'w']) {
      expect(commonMain).toMatch(new RegExp(`getBoneMatrix\\(\\s*skinIndex\\.${component}\\s*\\)`));
    }
  });

  it('still declares the marker the assembler splices this chunk in at', () => {
    // `assembleVertex` throws without it, but only at module load of every material -- and the chunk
    // itself is the half that can be edited without noticing the contract.
    expect(commonMain).toMatch(/mvPosition/);
    expect(commonMain).toMatch(/cameraDistance/);
  });
});
