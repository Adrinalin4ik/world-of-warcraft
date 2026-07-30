/**
 * Particle emitters in an M2 carry a template quad: a 6-vertex, 2-triangle submesh whose texture the
 * emitter names. The client never draws it directly, it instantiates it per particle. Drawn as
 * ordinary geometry it appears as an opaque blob -- the dark lumps over the lava at Blackrock.
 *
 * Both conditions below are required. Texture ownership alone would delete real geometry that happens
 * to share a texture with an emitter; the single-quad test alone would delete legitimate flat decals.
 */

const QUAD_VERTEX_COUNT = 6;
const QUAD_TRIANGLE_COUNT = 2;

export const collectEmitterTextureIndices = (
  particleEmitters: Array<{ textureId: number }> | undefined
): Set<number> => {
  const indices = new Set<number>();

  if (!particleEmitters) {
    return indices;
  }

  for (const emitter of particleEmitters) {
    indices.add(emitter.textureId);
  }

  return indices;
};

export const isParticleTemplate = (input: {
  vertexCount: number;
  triangleCount: number;
  textureIndices: number[];
  emitterTextureIndices: Set<number>;
}): boolean => {
  const { vertexCount, triangleCount, textureIndices, emitterTextureIndices } = input;

  if (emitterTextureIndices.size === 0 || textureIndices.length === 0) {
    return false;
  }

  if (vertexCount !== QUAD_VERTEX_COUNT || triangleCount !== QUAD_TRIANGLE_COUNT) {
    return false;
  }

  return textureIndices.every((index) => emitterTextureIndices.has(index));
};
