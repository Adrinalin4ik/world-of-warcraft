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
 * **A DIVERGENCE WAS TRIED HERE AND REVERTED, and the record is worth more than the code was.** I made
 * the camera keep any WALKABLE face regardless of NOCAMCOLLIDE, on the premise that the eye was ending
 * up under the abbey floor. The owner then measured the eye directly: `eyeToFeet` **+2.98** with the
 * floor 1.72 below it. The eye was never under the floor. The real cause was
 * `wmo-flags.ts#visibilityMask` carrying `0x40`, which made the camera resolve as EXTERIOR inside a lit
 * indoor room -- so the interior flood never seeded and the world looked wrong from above the floor.
 *
 * The bit is honoured exactly as the reference honours it
 * (`benilla-formats/src/models/collision.rs:89-99`), and should stay that way unless a MEASUREMENT of
 * the eye says otherwise.
 *
 * Every other MOPY bit is ignored. Treating one of them as a reject would silently delete
 * collision geometry, which reads as a building you can walk through.
 */
export function wmoFaceIsCollidable(flags: number, layer: CollisionLayer): boolean {
  const reject = layer === CollisionLayer.Walk ? MOPY_DETAIL : MOPY_NOCAMCOLLIDE;

  return (flags & reject) === 0;
}
