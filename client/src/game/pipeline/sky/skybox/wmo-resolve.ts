import GroupFlags from '../../wmo/group/flags';

/**
 * Resolve which WMO skybox (if any) the camera's current position asks for (celestial-sky plan, Task 6
 * Step 2, `MOSB`).
 *
 * **The predicate is the trap, and it is what shipped wrong in the reference first** (benilla
 * `wmo_sky.rs`'s module doc, which this ports): the group flag `SHOW_SKYBOX` (`0x40000`) is tested on
 * the groups the camera's portal flood REACHES, never on the group the camera stands in. In
 * Stratholme's King's Square the camera stands in group 39 -- the root's only EXTERIOR group, which
 * does NOT set the bit -- yet the reference draws the painted sky there, because 61 of the 83 groups
 * its flood reaches from group 39 do carry it. So the predicate is: *any flood-reached group carries
 * `SHOW_SKYBOX`, AND the root names a MOSB*.
 *
 * This client already floods the portal graph every frame the camera moves, for view-frustum culling
 * (`world/visibility-manager.js`'s `traversePortalsAndEnable`), and marks every group it reaches
 * `view.visible = true` (clipped by the frustum along the way, same as the reference's own flood, which
 * seeds from "every frustum-visible EXTERIOR group on the outside leg"). Reusing that visibility flag
 * IS reusing the flood -- there is no second BFS here, and there must not be one (a second flood is a
 * second chance for the two to disagree about which groups are "reached").
 *
 * Four roots name a MOSB no group ever asks for (DireMaul's instance shell, `Stratholme_A`, and both
 * Sunken Temple roots -- whose MOSB is not even a model path, it is the literal string "the temple of
 * atal'hakkar"). Keying off the MOSB chunk alone would paint skies the reference never shows; requiring
 * a flood-reached `SHOW_SKYBOX` group as well is what keeps those four silent.
 *
 * `wmoManager` is duck-typed (`any`) rather than importing `WMOManager`/`WMO` -- both are untyped JS
 * classes, and this resolver only ever touches the same three properties `VisibilityManager` itself
 * reads off them (`entries`, `groups`, `views.groups`).
 */
export function resolveActiveWmoSkybox(wmoManager: any): string | null {
  if (!wmoManager || !wmoManager.entries) {
    return null;
  }

  // `Array.prototype.sort`-free `min()`, mirroring benilla's own `.min()` over the candidate set: with
  // `Map` iteration order not guaranteed stable across frames, "first match" would let two qualifying
  // skyboxes alternate frame to frame on a tie. In practice at most one 1.12 root ever qualifies
  // (Stratholme_B -- the Caverns of Time shells are unreleased), so this never actually has to pick.
  let best: string | null = null;

  for (const wmo of wmoManager.entries.values()) {
    const skybox: string | null = wmo?.root?.skybox ?? null;
    if (!skybox) {
      continue;
    }

    let reached = false;
    for (const group of wmo.groups.values()) {
      if ((group.header.flags & GroupFlags.SHOW_SKYBOX) === 0) {
        continue;
      }

      const view = wmo.views.groups.get(group.index);
      if (view && view.visible) {
        reached = true;
        break;
      }
    }

    if (reached && (best === null || skybox < best)) {
      best = skybox;
    }
  }

  return best;
}
