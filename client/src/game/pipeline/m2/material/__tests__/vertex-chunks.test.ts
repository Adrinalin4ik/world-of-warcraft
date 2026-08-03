/**
 * @jest-environment node
 */
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
describe('M2 vertex common-main', () => {
  /** The `worldVertexNormal` assignments, one per #ifdef branch. */
  const normalAssignments = commonMain
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

  it('still declares the marker the assembler splices this chunk in at', () => {
    // `assembleVertex` throws without it, but only at module load of every material -- and the chunk
    // itself is the half that can be edited without noticing the contract.
    expect(commonMain).toMatch(/mvPosition/);
    expect(commonMain).toMatch(/cameraDistance/);
  });
});
