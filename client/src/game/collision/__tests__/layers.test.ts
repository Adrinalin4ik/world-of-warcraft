/**
 * @jest-environment node
 */
import { CollisionLayer, MOPY_DETAIL, MOPY_NOCAMCOLLIDE, wmoFaceIsCollidable } from '../layers';

/**
 * The player body and the camera collide against DIFFERENT sets of WMO faces. Walk drops DETAIL
 * (0x04); camera drops NOCAMCOLLIDE (0x02). So the camera collides with visible decals and
 * overhangs the player walks under -- forge pipes, low beams -- and passes through the railings the
 * player still stands on.
 */
describe('wmoFaceIsCollidable', () => {
  it('collides a plain face with both audiences', () => {
    expect(wmoFaceIsCollidable(0x00, CollisionLayer.Walk)).toBe(true);
    expect(wmoFaceIsCollidable(0x00, CollisionLayer.Camera)).toBe(true);
  });

  it('lets the player walk under a DETAIL face while the camera still hits it', () => {
    expect(wmoFaceIsCollidable(MOPY_DETAIL, CollisionLayer.Walk)).toBe(false);
    expect(wmoFaceIsCollidable(MOPY_DETAIL, CollisionLayer.Camera)).toBe(true);
  });

  it('lets the camera pass through a NOCAMCOLLIDE face the player stands on', () => {
    expect(wmoFaceIsCollidable(MOPY_NOCAMCOLLIDE, CollisionLayer.Walk)).toBe(true);
    expect(wmoFaceIsCollidable(MOPY_NOCAMCOLLIDE, CollisionLayer.Camera)).toBe(false);
  });

  it('excludes a face flagged both ways from both audiences', () => {
    const both = MOPY_DETAIL | MOPY_NOCAMCOLLIDE;

    expect(wmoFaceIsCollidable(both, CollisionLayer.Walk)).toBe(false);
    expect(wmoFaceIsCollidable(both, CollisionLayer.Camera)).toBe(false);
  });

  it('ignores every other MOPY bit', () => {
    // 0x01 UNK, 0x08 COLLIDE_HIT, 0x10 UNK, 0x20 COLLISION, 0x40 HINT, 0x80 RENDER -- none of
    // these gate either audience, and treating one as a reject would silently delete geometry.
    for (const bit of [0x01, 0x08, 0x10, 0x20, 0x40, 0x80]) {
      expect(wmoFaceIsCollidable(bit, CollisionLayer.Walk)).toBe(true);
      expect(wmoFaceIsCollidable(bit, CollisionLayer.Camera)).toBe(true);
    }
  });

  it('reads the reject bit out of a realistic mixed flags byte', () => {
    // RENDER | COLLISION | DETAIL: a decorative but solid-to-the-camera face.
    expect(wmoFaceIsCollidable(0x80 | 0x20 | MOPY_DETAIL, CollisionLayer.Walk)).toBe(false);
    expect(wmoFaceIsCollidable(0x80 | 0x20 | MOPY_DETAIL, CollisionLayer.Camera)).toBe(true);
  });
});
