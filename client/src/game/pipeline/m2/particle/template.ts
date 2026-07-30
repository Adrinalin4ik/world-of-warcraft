/**
 * Whether a model's own submeshes belong to the particle system rather than the scene graph.
 *
 * An M2 with particle emitters carries geometry that exists to be instanced once per particle. The real
 * client never draws it directly, and drawn as ordinary geometry it appears as opaque quads -- the dark
 * lumps that used to sit over the lava at Blackrock.
 *
 * This replaces an earlier heuristic that also required exactly one submesh of exactly 6 vertices. That
 * was a guess made before the particle system existed, and it missed real models:
 * WORLD\GENERIC\PASSIVEDOODADS\PARTICLEEMITTERS\ASHENVALEWISPS.M2 has a 15-vertex submesh and slipped
 * through, drawing solid quads. Now that emitters are rendered, presence of an emitter is the whole
 * test.
 */
export const modelOwnsSubmeshes = (particleEmitterCount: number): boolean =>
  typeof particleEmitterCount === 'number' && particleEmitterCount > 0;
