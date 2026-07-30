/**
 * @jest-environment node
 */
import { collectEmitterTextureIndices, isParticleTemplate } from '../template';

describe('collectEmitterTextureIndices', () => {
  it('gathers texture ids from every emitter', () => {
    const set = collectEmitterTextureIndices([{ textureId: 2 }, { textureId: 5 }, { textureId: 2 }]);

    expect([...set].sort()).toEqual([2, 5]);
  });

  it('returns an empty set when there are no emitters', () => {
    expect(collectEmitterTextureIndices(undefined).size).toBe(0);
    expect(collectEmitterTextureIndices([]).size).toBe(0);
  });
});

describe('isParticleTemplate', () => {
  const emitterTextureIndices = new Set([2]);

  it('accepts a single quad whose texture an emitter owns', () => {
    expect(isParticleTemplate({
      vertexCount: 6, triangleCount: 2, textureIndices: [2], emitterTextureIndices
    })).toBe(true);
  });

  it('rejects geometry larger than one quad', () => {
    expect(isParticleTemplate({
      vertexCount: 24, triangleCount: 12, textureIndices: [2], emitterTextureIndices
    })).toBe(false);
  });

  it('rejects a quad whose texture no emitter owns', () => {
    expect(isParticleTemplate({
      vertexCount: 6, triangleCount: 2, textureIndices: [7], emitterTextureIndices
    })).toBe(false);
  });

  it('rejects a quad using a mix of owned and unowned textures', () => {
    expect(isParticleTemplate({
      vertexCount: 6, triangleCount: 2, textureIndices: [2, 7], emitterTextureIndices
    })).toBe(false);
  });

  it('rejects everything when the model has no emitters', () => {
    expect(isParticleTemplate({
      vertexCount: 6, triangleCount: 2, textureIndices: [2], emitterTextureIndices: new Set<number>()
    })).toBe(false);
  });

  it('rejects a quad with no texture information', () => {
    expect(isParticleTemplate({
      vertexCount: 6, triangleCount: 2, textureIndices: [], emitterTextureIndices
    })).toBe(false);
  });
});
