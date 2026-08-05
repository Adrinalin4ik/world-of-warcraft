/**
 * The glue scene's contract with `M2Blueprint`.
 *
 * `M2` sets `this.visible = false` in its constructor (`pipeline/m2/index.ts`) — a blueprint hands
 * back a HIDDEN group, and every consumer in the world turns it on through the visibility manager.
 * The glue scene has no visibility manager, so it must do that itself; when it did not, the model
 * loaded, armed, lit and posed correctly and still submitted zero draw calls, which is
 * indistinguishable from a black screen caused by anything else.
 */
import * as THREE from 'three';

const mockLoad = jest.fn();
const mockUnload = jest.fn();

jest.mock('../../../pipeline/m2/blueprint', () => ({
  __esModule: true,
  default: { load: (...args: unknown[]) => mockLoad(...args), unload: (...args: unknown[]) => mockUnload(...args) },
}));

jest.mock('../../../pipeline/m2/material/per-object-light', () => ({
  __esModule: true,
  applyPerObjectLighting: jest.fn(),
  MAX_POINT_LIGHTS: 3,
}));

// eslint-disable-next-line import/first
import { GlueSceneView } from '../glue-scene';

/** A stand-in for the parsed model: a hidden group, exactly as `M2Blueprint.load` resolves it. */
function fakeModel() {
  const model = new THREE.Group() as unknown as THREE.Group & Record<string, unknown>;
  model.visible = false;
  model.data = { cameras: [], lights: [], attachments: [] };
  model.modelAnim = { sequences: [] };
  model.instanceAnim = null;
  model.evaluateMaterialChannels = jest.fn();
  model.applyPose = jest.fn();
  return model;
}

function fakeRenderer() {
  return {
    getSize: (target: THREE.Vector2) => target.set(1382, 911),
    render: jest.fn(),
    info: { render: { calls: 0, triangles: 0 } },
  } as unknown as THREE.WebGLRenderer;
}

describe('GlueSceneView', () => {
  beforeEach(() => {
    mockLoad.mockReset();
    mockUnload.mockReset();
  });

  it('shows the model, which the blueprint hands over hidden', async () => {
    const model = fakeModel();
    mockLoad.mockResolvedValue(model);

    const view = new GlueSceneView(fakeRenderer());
    view.setScene({ kind: 'mainmenu', northrend: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(model.visible).toBe(true);
  });

  it('renders the scene once a model and its rig are in place', async () => {
    const model = fakeModel();
    mockLoad.mockResolvedValue(model);
    const renderer = fakeRenderer();

    const view = new GlueSceneView(renderer);
    view.setScene({ kind: 'mainmenu', northrend: false });
    await Promise.resolve();
    await Promise.resolve();
    view.render();

    expect(renderer.render).toHaveBeenCalled();
  });

  it('draws nothing at all before a scene is requested', () => {
    const renderer = fakeRenderer();
    const view = new GlueSceneView(renderer);

    view.update(0.016);
    view.render();

    expect(renderer.render).not.toHaveBeenCalled();
  });
});
