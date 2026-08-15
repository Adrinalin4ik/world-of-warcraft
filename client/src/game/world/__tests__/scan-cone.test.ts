/**
 * TAB's cone: the tier and the order, on the shape the live run produced.
 *
 * Measured on :3000 as `Sgh` (`scratchpad/t20-target.js`) with the character facing 114.4 degrees: three
 * candidates fell inside the cone at 18.2 / 19.9 / 34.3 yd and were admitted in exactly that order,
 * while a candidate 14.3 yd away at 118 degrees off the facing was not admitted at all. This is that.
 */
import * as THREE from 'three';

import { nearestEnemy, emptyScanReport } from '../scan';

/** Just enough `Unit` for the scan: a position, a type, a live faction template and a facing. */
function unit(guid: string, x: number, y: number) {
  const view = new THREE.Object3D();
  view.position.set(x, y, 0);
  return {
    guid,
    objectType: 3,
    view,
    dead: false,
    // `reactionFor` short-circuits on a unit that already carries a reaction, so no DBC is needed:
    // 2 is HOSTILE (`world/faction.ts:42`).
    reaction: 2,
    fields: {},
    rotation: { z: 0 },
    get facing() { return this.rotation.z; },
  } as never;
}

test('the cone admits by heading and orders by distance; a close unit behind is out', () => {
  const me = unit('0xme', 0, 0);
  // Facing +X (0 rad), which is the wire convention `Unit#facing` carries.
  const near = unit('0xnear', 18, 1);     // ~3 degrees off -- in cone
  const far = unit('0xfar', 34, 6);       // ~10 degrees off -- in cone
  const behind = unit('0xbehind', -14, 3); // ~168 degrees off, 14 yd -- out of cone AND out of the 10-yd bubble
  const entities = [me, near, far, behind];
  const world = {
    entities: { forEach: (fn: (u: never) => void) => entities.forEach(fn) },
    player: me,
    target: null as never,
  };

  const report = emptyScanReport();
  expect((nearestEnemy(world, false, report) as { guid: string }).guid).toBe('0xnear');
  expect(report.order).toEqual(['0xnear', '0xfar']);

  // A press with the nearest already selected walks to the next one.
  world.target = near;
  expect((nearestEnemy(world) as { guid: string }).guid).toBe('0xfar');
  // And the last wraps back to the first.
  world.target = far;
  expect((nearestEnemy(world) as { guid: string }).guid).toBe('0xnear');
});
