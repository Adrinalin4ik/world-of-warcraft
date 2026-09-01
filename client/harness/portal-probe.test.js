/**
 * @jest-environment node
 */
const THREE = require('three');
const { buildAbbey } = require('./build');
const LocationManager = require('../src/game/world/location-manager').default;
const VisibilityManager = require('../src/game/world/visibility-manager').default;

/** The abbey at the world origin, unrotated: local space IS world space, so ADT is out of the loop. */
function stage() {
  const { root, groups } = buildAbbey();

  const rootView = root.createView();
  rootView.updateMatrixWorld(true);

  const portalViews = new Map();
  for (let index = 0; index < root.portals.length; index++) {
    const view = root.portals[index].createView();
    rootView.add(view);
    view.updateMatrix();
    view.updateMatrixWorld();
    portalViews.set(index, view);
  }

  const groupViews = new Map();
  for (const [index, group] of groups) {
    const view = group.createView();
    rootView.add(view);
    groupViews.set(index, view);
  }
  rootView.updateMatrixWorld(true);

  const wmo = {
    root,
    groups,
    views: { root: rootView, groups: groupViews, portals: portalViews },
    doodads: new Map(),
    doodadsForGroup: () => [],
  };

  const map = {
    chunks: new Map(),
    doodadManager: { doodads: new Map() },
    wmoManager: { entries: new Map([[0, wmo]]) },
    exterior: { visible: false },
  };

  return { wmo, map, groups, root };
}

function look(from, at) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1 / 9, 1000);
  camera.name = 'MainCamera';
  camera.up.set(0, 0, 1);
  camera.position.set(from[0], from[1], from[2]);
  camera.lookAt(new THREE.Vector3(at[0], at[1], at[2]));
  camera.updateMatrix();
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  return camera;
}

it('reports group boxes and what a camera resolves', () => {
  const { wmo, map, groups } = stage();

  const boxes = [...groups.values()].map((g) => {
    const b = g.boundingBox;
    return {
      i: g.index,
      ext: !g.interior,
      x: [+b.min.x.toFixed(1), +b.max.x.toFixed(1)],
      y: [+b.min.y.toFixed(1), +b.max.y.toFixed(1)],
      z: [+b.min.z.toFixed(1), +b.max.z.toFixed(1)],
    };
  });

  const loc = new LocationManager(map);
  const vm = new VisibilityManager(map);

  // The doorway, from the owner's own groupProbe reading.
  const body = new THREE.Vector3(-27.72, 30.38, 2.16);
  const camera = look([-27.72, 38, 5], [-27.72, 20, 3]);

  loc.update([camera], body);
  vm.update([camera], body);

  const drawn = [...wmo.views.groups.entries()]
    .filter(([, v]) => v.visible)
    .map(([i]) => i)
    .sort((a, b) => a - b);

  console.log('BOXES ' + JSON.stringify(boxes));
  console.log('PROBE ' + JSON.stringify({
    locationType: camera.location && camera.location.type,
    locationGroup: camera.location && camera.location.group && camera.location.group.index,
    drawn,
    exteriorVisible: map.exterior.visible,
  }));
  expect(true).toBe(true);
});
