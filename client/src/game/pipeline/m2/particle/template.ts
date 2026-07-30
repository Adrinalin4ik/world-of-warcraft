/**
 * Particle emitters in an M2 carry a template quad: a 6-vertex (4 unique, de-indexed to 6),
 * 2-triangle submesh. The client never draws it directly, it instantiates it per particle. Drawn
 * as ordinary geometry it appears as an opaque blob -- the dark lumps over the lava at Blackrock.
 *
 * An earlier version of this rule suppressed a submesh only when every texture its batches used
 * was also referenced by a particle emitter. That is unsatisfiable in practice: an emitter's
 * particle texture and the model's renderable geometry resolve to different textures. Measured
 * offline on the two real Blackrock emitter models:
 *
 * - LAVASMOKEEMITTERB.M2: textures are 0: SMOKEWISPY02.BLP, 1: CREATURE\GHOST\BLACK32.BLP,
 *   2: GENERICGLOW2_32.BLP. Emitter textureIds are [0, 0, 0, 2]. textureLookups = [1], and the
 *   single batch has textureLookup = 0, so the drawn submesh resolves to texture index 1 -- which
 *   no emitter references.
 * - LAVASPLASHPARTICLE.M2: textures are 0: LAVASPLASHBUBLE.BLP, 1: Ball1.blp. Emitter textureIds
 *   are [0]. The batch resolves to index 1 again.
 *
 * So texture ownership never holds and the old predicate never fired. The rule here drops texture
 * comparison entirely and instead relies on shape: a model whose entire renderable content is a
 * single submesh, that submesh being exactly one quad, and the model carrying at least one
 * particle emitter, is an emitter-only doodad -- there is nothing else for it to be. A torch
 * (wooden post plus flame) has several submeshes, so it is untouched by the submeshCount === 1
 * condition even though one of its submeshes might itself be a quad.
 */

const QUAD_VERTEX_COUNT = 6;
const QUAD_TRIANGLE_COUNT = 2;

export const isParticleTemplate = (input: {
  emitterCount: number;
  submeshCount: number;
  vertexCount: number;
  triangleCount: number;
}): boolean => {
  const { emitterCount, submeshCount, vertexCount, triangleCount } = input;

  if (emitterCount === 0) {
    return false;
  }

  if (submeshCount !== 1) {
    return false;
  }

  return vertexCount === QUAD_VERTEX_COUNT && triangleCount === QUAD_TRIANGLE_COUNT;
};
