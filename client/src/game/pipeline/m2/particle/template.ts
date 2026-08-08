/**
 * A particle emitter's template quad, which the particle system draws rather than the scene graph.
 *
 * An earlier revision of this predicate suppressed a submesh whenever its model carried any particle
 * emitter at all, on the theory that an emitter's geometry exists to be instanced per particle rather
 * than drawn once. That was wrong: emitters are decorations *attached to* geometry, not replacements
 * for it. Verified in-client at Blackrock, the broader rule deleted real world geometry wholesale:
 *
 *     TORCH.M2                34 instances, 1 emitter -> 0 meshes
 *     FELWOODMUSHROOMANIM.M2  55 instances, 3 emitters -> 0 meshes
 *     GENERALTORCH01.M2       17 instances, 2 emitters -> 0 meshes
 *     BURNINGMIDTREE02.M2      1 instance,  2 emitters -> 0 meshes
 *     VOLCANICVENT* / LAVAPLUG*  10 instances -> 0 meshes
 *
 * 34 torches with no torch, 55 mushrooms with no mushroom, a burning tree with no tree. So this
 * reverts to the narrower Phase 1 predicate, which only ever caught emitter-only models: a model
 * whose entire renderable content is a single submesh, that submesh being exactly one quad (6
 * vertices, 2 triangles), and the model carrying at least one particle emitter. A torch (wooden post
 * plus flame) has several submeshes, so it is untouched by the submeshCount === 1 condition even
 * though one of its submeshes might itself be a quad.
 *
 * Known remaining gap: WORLD\GENERIC\PASSIVEDOODADS\PARTICLEEMITTERS\ASHENVALEWISPS.M2 has a single
 * 15-vertex submesh, so it is not caught by this predicate and still draws its emitter geometry as
 * solid quads. Losing that one case is far cheaper than deleting a hundred pieces of world geometry,
 * and the real discriminator -- whatever the original client uses to know that an emitter-only
 * model's quad is not drawable -- is still unknown.
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

  return emitterCount > 0 && submeshCount === 1 &&
    vertexCount === QUAD_VERTEX_COUNT && triangleCount === QUAD_TRIANGLE_COUNT;
};
