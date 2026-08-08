/**
 * @jest-environment node
 */
import { isParticleTemplate } from '../template';

describe('isParticleTemplate', () => {
  it('fires for a model whose entire content is a single quad submesh with an emitter', () => {
    expect(isParticleTemplate({
      emitterCount: 1, submeshCount: 1, vertexCount: 6, triangleCount: 2
    })).toBe(true);
  });

  it('does not fire when the model has no particle emitters', () => {
    expect(isParticleTemplate({
      emitterCount: 0, submeshCount: 1, vertexCount: 6, triangleCount: 2
    })).toBe(false);
  });

  it('does not fire when the model has more than one submesh', () => {
    expect(isParticleTemplate({
      emitterCount: 1, submeshCount: 2, vertexCount: 6, triangleCount: 2
    })).toBe(false);
  });

  it('does not fire for geometry larger than one quad', () => {
    expect(isParticleTemplate({
      emitterCount: 1, submeshCount: 1, vertexCount: 24, triangleCount: 12
    })).toBe(false);
  });

  it('does not fire for a 15-vertex single submesh, the known ASHENVALEWISPS.M2 gap', () => {
    // ASHENVALEWISPS.M2 has a single 15-vertex submesh alongside its emitter, so it is not caught by
    // this predicate and still draws its emitter geometry as solid quads. This is a deliberate,
    // tested limitation rather than an oversight -- see the module docblock.
    expect(isParticleTemplate({
      emitterCount: 1, submeshCount: 1, vertexCount: 15, triangleCount: 5
    })).toBe(false);
  });
});
