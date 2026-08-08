import r from 'restructure';

import Entity from '../entity';
import StringRef from '../string-ref';

export default Entity({
  id: r.uint32le,
  flags: r.uint32le,
  file: StringRef,
  sizeClass: r.uint32le,
  scale: r.floatle,
  bloodID: r.int32le,

  // Fields 6..13: footprintTextureID, footprintTextureLength, footprintTextureWidth,
  // footprintParticleScale, foleyMaterialID, footstepShakeSize, deathThudShakeSize, soundID.
  skipsBeforeCollision: new r.Reserved(r.uint32le, 8),

  // Fields 14/15. `collisionHeight * displayScale` is the unit's world collision height -- the
  // number every swim depth line is a fraction of: water must cover 0.75 of it to start swimming,
  // and a surfacing swimmer rests 0.75 of it below the waterline. Per-unit, deliberately: one
  // human-sized constant puts a gnome's rest line above her own head, so she can never surface.
  //
  // NOT the movement capsule height, which is a constant feel knob. Different quantities.
  collisionWidth: r.floatle,
  collisionHeight: r.floatle,

  // Fields 16..27: mountHeight, geoBoxMin[3], geoBoxMax[3], worldEffectScale, attachedEffectScale,
  // missileCollisionRadius, missileCollisionPush, missileCollisionRaise.
  skipsAfterCollision: new r.Reserved(r.uint32le, 12)
});
