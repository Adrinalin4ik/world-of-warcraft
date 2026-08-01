/**
 * Down-ray seed generation for the portal flood.
 *
 * The camera's "current group" is not one group: walking-collision faces race portal crossings
 * under the eye, so the reference's verdict is a SEED SET -- in-group and across-group -- each
 * flooded as an independent root (samples/benilla `wmo_portal/seed.rs`, byte-audited against
 * `wmo-current-group.md` / `wmo-portal-audit.md`). A single seed is why standing on a threshold can
 * blank whichever room the collision face happened not to pick.
 */

/**
 * Ray-vs-plane near-parallel threshold on the denominator (the client's f64 `0x811658`). Below it,
 * the down-ray is parallel to the portal plane and the crossing exists only via the snap.
 */
export const PORTAL_NEAR_PARALLEL = 1.0e-4;

/**
 * The "eye embedded in the plane" snap window, WMO yards (the client's `0.1` immediate pushed at
 * `0x6a40c0`): a vertical doorway counts as crossed by the vertical down-ray only when the eye is
 * this close to its plane.
 */
export const SNAP_WINDOW = 0.1;

/**
 * Does a straight-down ray from the eye cross this portal's plane?
 *
 * @param planeNormalZ   the portal plane normal's Z component in WMO local space -- the denominator
 *                       of the ray/plane intersection for a straight-down ray. Only its magnitude
 *                       decides parallelism.
 * @param signedDistance the plane's signed distance to the eye.
 */
export function crossesDownRay(planeNormalZ: number, signedDistance: number): boolean {
  if (Math.abs(planeNormalZ) < PORTAL_NEAR_PARALLEL) {
    // Parallel: a vertical doorway. It counts as crossed only when the eye is embedded in its
    // plane, within the snap window.
    return Math.abs(signedDistance) <= SNAP_WINDOW;
  }

  // A downward ray reaches the plane when the eye is on the plane's positive side.
  return signedDistance > 0;
}
