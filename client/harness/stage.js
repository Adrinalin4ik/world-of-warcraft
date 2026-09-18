const THREE = require('three');
const { buildAbbey } = require('./build');

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


module.exports = { stage, look };
