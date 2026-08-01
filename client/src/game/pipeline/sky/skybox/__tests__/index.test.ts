import Skybox from '..';

jest.mock('../../../dbc', () => ({
  __esModule: true,
  default: { load: jest.fn() },
}));

jest.mock('../model', () => ({
  __esModule: true,
  loadSkyboxBatches: jest.fn(),
  buildSkyboxMeshes: jest.fn(() => []),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DBC = require('../../../dbc').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const model = require('../model');

/**
 * Drive one id through the private resolve and wait for it to settle, in the same order `update()`
 * does it: stamp `currentID` first, then load. `isActive` reads both, so a helper that skipped the
 * stamp would report inactive even on success.
 */
const resolve = async (skybox: Skybox, id: number) => {
  const internals = skybox as unknown as {
    currentID: number | null;
    resolveAndLoad(id: number): Promise<void>;
  };
  internals.currentID = id;
  await internals.resolveAndLoad(id);
};

beforeEach(() => {
  jest.clearAllMocks();
  model.buildSkyboxMeshes.mockReturnValue([]);
});

describe('Skybox model path', () => {
  it('rewrites the DBC\'s .mdx extension to the shipped .m2', async () => {
    // LightSkybox.dbc stores the authoring-time extension, not the shipped one: every row names a
    // `.mdx` while the file in the data chain is `.m2`. Nagrand's row 12 is
    // `Environments\Stars\NagrandSkyBox.mdx`, and asking for that 404s for every skybox zone.
    DBC.load.mockResolvedValue({ file: 'Environments\\Stars\\NagrandSkyBox.mdx' });
    model.loadSkyboxBatches.mockResolvedValue([{}]);

    await resolve(new Skybox(), 12);

    expect(model.loadSkyboxBatches).toHaveBeenCalledWith('Environments\\Stars\\NagrandSkyBox.m2');
  });

  it('leaves a path that already names .m2 alone', async () => {
    DBC.load.mockResolvedValue({ file: 'Environments\\Stars\\Something.m2' });
    model.loadSkyboxBatches.mockResolvedValue([{}]);

    await resolve(new Skybox(), 7);

    expect(model.loadSkyboxBatches).toHaveBeenCalledWith('Environments\\Stars\\Something.m2');
  });
});

describe('Skybox.isActive', () => {
  it('stops suppressing the rest of the sky when the model cannot load', async () => {
    // The bug this guards: `isActive` was gated on the published DBC id alone, so a skybox that
    // drew NOTHING still suppressed the gradient dome, the clouds, the stars and both discs. With
    // Nagrand's model 404ing, the whole sky rendered as the bare clear colour -- reported as
    // "Nagrand skybox is 100% white".
    DBC.load.mockResolvedValue({ file: 'Environments\\Stars\\Missing.mdx' });
    model.loadSkyboxBatches.mockRejectedValue(new Error('404'));

    const skybox = new Skybox();
    await resolve(skybox, 12);

    expect(skybox.isActive).toBe(false);
  });

  it('stops suppressing when the model decodes to nothing drawable', async () => {
    DBC.load.mockResolvedValue({ file: 'Environments\\Stars\\Empty.mdx' });
    model.loadSkyboxBatches.mockResolvedValue([]);

    const skybox = new Skybox();
    await resolve(skybox, 12);

    expect(skybox.isActive).toBe(false);
  });

  it('stops suppressing when the DBC row names no model at all', async () => {
    DBC.load.mockResolvedValue({ file: '' });

    const skybox = new Skybox();
    await resolve(skybox, 12);

    expect(skybox.isActive).toBe(false);
  });

  it('suppresses once a model actually loads', async () => {
    DBC.load.mockResolvedValue({ file: 'Environments\\Stars\\NagrandSkyBox.mdx' });
    model.loadSkyboxBatches.mockResolvedValue([{}]);

    const skybox = new Skybox();
    await resolve(skybox, 12);

    expect(skybox.isActive).toBe(true);
  });

  it('gives a new zone a fresh attempt after a previous one failed', async () => {
    const skybox = new Skybox();

    DBC.load.mockResolvedValue({ file: 'Environments\\Stars\\Missing.mdx' });
    model.loadSkyboxBatches.mockRejectedValue(new Error('404'));
    await resolve(skybox, 12);
    expect(skybox.isActive).toBe(false);

    DBC.load.mockResolvedValue({ file: 'Environments\\Stars\\Works.mdx' });
    model.loadSkyboxBatches.mockResolvedValue([{}]);
    await resolve(skybox, 13);
    expect(skybox.isActive).toBe(true);
  });
});
