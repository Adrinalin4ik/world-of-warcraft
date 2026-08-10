import { CollisionLayer } from './types';

export { CollisionLayer };

/**
 * MOPY `0x04` DETAIL -- decorative geometry the player walks under, but which the camera must still
 * stop at. Dropped from the WALK face set.
 */
export const MOPY_DETAIL = 0x04;

/**
 * MOPY `0x02` NOCAMCOLLIDE -- faces the player stands on but the camera passes through. Dropped
 * from the CAMERA face set.
 */
export const MOPY_NOCAMCOLLIDE = 0x02;

/**
 * Is this WMO face part of the given audience's collision set?
 *
 * The player body collides with terrain, doodads and WMO faces minus DETAIL; the camera collides
 * with terrain, doodads and WMO faces minus NOCAMCOLLIDE. That asymmetry is the whole point of
 * having two audiences: the camera stops at the forge pipes you walk under, and threads the
 * railings you stand on.
 *
 * Every other MOPY bit is ignored. Treating one of them as a reject would silently delete
 * collision geometry, which reads as a building you can walk through.
 */
export function wmoFaceIsCollidable(flags: number, layer: CollisionLayer): boolean {
  const reject = layer === CollisionLayer.Walk ? MOPY_DETAIL : MOPY_NOCAMCOLLIDE;

  return (flags & reject) === 0;
}
