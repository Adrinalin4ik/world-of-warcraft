/**
 * MOGP group flags, and which of them decide the VISIBILITY class.
 *
 * Two different laws key on these bits and must not be conflated:
 *
 *  - **Lighting** forks on `MOGI & 0x48` -- EXTERIOR or EXTERIOR_LIT both take the sunlit leg.
 *  - **Visibility / the portal graph** uses EXTERIOR (0x8) alone. benilla calls a
 *    `0x40`-without-`0x8` group "an interior-graph group lit as OUTDOORS": it participates in the
 *    portal flood, and the outdoor world is drawn through the windows that flood leaves.
 *
 * Stormwind's streets are exactly that kind -- 88 of the loaded groups here carry `0x40` without
 * `0x8`, against 10 with `0x8`.
 */
export const EXTERIOR = 0x08;
export const EXTERIOR_LIT = 0x40;

/**
 * The mask the visibility classifier and the portal flood test against.
 *
 * `EXTERIOR` alone is the faithful value. It is a mutable knob rather than a constant because
 * switching it changes behaviour drastically and reversibly, which is how it gets measured:
 *
 *   WmoFlags.visibilityMask = 0x08; world.map.updateVisibility(world.game.camera)
 *
 * With `0x08`, city street groups are portal-gated and the exterior is drawn only through portal
 * windows -- so it depends on the deferred-window pass actually reaching outdoors. With `0x48` the
 * streets are treated as outdoors outright, which draws everything unconditionally: safe, but it
 * removes cities from the portal graph entirely.
 */
export const WmoFlags = {
  visibilityMask: EXTERIOR | EXTERIOR_LIT,
};

if (typeof window !== 'undefined') {
  (window as any).WmoFlags = WmoFlags;
}
