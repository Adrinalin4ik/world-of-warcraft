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

  it('does not fire for a single quad within a model that has two submeshes', () => {
    expect(isParticleTemplate({
      emitterCount: 1, submeshCount: 2, vertexCount: 6, triangleCount: 2
    })).toBe(false);
  });
});
