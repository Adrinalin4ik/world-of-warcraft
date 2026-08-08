import * as THREE from 'three';

export type WorldSpaceWmoLight = {
  position: THREE.Vector3;
  color: { r: number; g: number; b: number };
  intensity: number;
  attenStart: number;
  attenEnd: number;
};

/**
 * MOLT lights converted to world space, cached on the WMO INSTANCE (`wmo`, one per placement).
 *
 * Deliberately cached on the instance rather than `wmo.root`: `WMORootLoader` caches `WMORoot` --
 * and therefore `root.lights` -- BY FILENAME, so the same root (and the same light array) is
 * shared by every placement of that building in the world. A WMO never moves once placed, so
 * converting once per instance (rather than every frame, and rather than sharing one conversion
 * across placements) is both correct and cheap.
 *
 * Positionally aligned with `wmo.root.lights`, holes and all (see
 * `WMORootDefinition.createLights`) -- so a group's MOLR ref (a raw MOLT index) can index this
 * array directly. Callers must skip `null` entries themselves.
 *
 * Shared by `MapLight` (nearest-to-camera exterior/ambient point light selection) and the WMO
 * doodad interior-probe fold, which is why this lives here rather than as a second, private
 * conversion on either caller.
 */
export function worldSpaceLightsForWmo(wmo: any): Array<WorldSpaceWmoLight | null> | null {
  if (!wmo.root || !wmo.root.lights || !wmo.views || !wmo.views.root) {
    return null;
  }

  if (!wmo.worldSpaceLights) {
    const root = wmo.views.root;
    root.updateMatrixWorld(true);

    wmo.worldSpaceLights = wmo.root.lights.map((light: any) => {
      if (!light) {
        return null;
      }

      return {
        position: root.localToWorld(
          new THREE.Vector3(light.position.x, light.position.y, light.position.z)
        ),
        color: light.color,
        intensity: light.intensity,
        attenStart: light.attenStart,
        attenEnd: light.attenEnd,
      };
    });
  }

  return wmo.worldSpaceLights;
}
