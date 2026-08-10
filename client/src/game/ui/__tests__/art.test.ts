import TextureLoader from '../../pipeline/texture-loader';
import { GlueArt } from '../art';

jest.mock('../../pipeline/texture-loader', () => ({
  __esModule: true,
  default: {
    load: jest.fn(),
    unload: jest.fn(),
  },
}));

const mockedLoader = TextureLoader as unknown as {
  load: jest.Mock;
  unload: jest.Mock;
};

beforeEach(() => {
  mockedLoader.load.mockReset();
  mockedLoader.unload.mockReset();
});

describe('GlueArt', () => {
  it('releases a loaded texture through TextureLoader.unload on dispose', async () => {
    const texture = {};
    mockedLoader.load.mockResolvedValue(texture);

    const art = new GlueArt();
    art.register('logo', { path: 'Interface\\Glues\\Common\\Glues-WoW-Logo' });
    await art.load();

    expect(art.texture('logo')).toBe(texture);

    art.dispose();

    expect(mockedLoader.unload).toHaveBeenCalledWith(texture);
    expect(art.texture('logo')).toBeNull();
  });

  it('releases a load still in flight when dispose runs before it settles', async () => {
    const texture = {};
    let resolveLoad!: (value: unknown) => void;
    mockedLoader.load.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );

    const art = new GlueArt();
    art.register('logo', { path: 'Interface\\Glues\\Common\\Glues-WoW-Logo' });
    const loading = art.load();

    // Disposal races ahead of the in-flight fetch -- the texture is not in the map yet.
    art.dispose();
    expect(mockedLoader.unload).not.toHaveBeenCalled();

    resolveLoad(texture);
    await loading;

    // The reference TextureLoader.load already counted is released once the fetch settles,
    // rather than being written into a dead instance's map and stranded forever.
    expect(mockedLoader.unload).toHaveBeenCalledWith(texture);
    expect(art.texture('logo')).toBeNull();
  });

  it('is safe to dispose twice', async () => {
    const texture = {};
    mockedLoader.load.mockResolvedValue(texture);

    const art = new GlueArt();
    art.register('logo', { path: 'Interface\\Glues\\Common\\Glues-WoW-Logo' });
    await art.load();

    art.dispose();
    art.dispose();

    expect(mockedLoader.unload).toHaveBeenCalledTimes(1);
  });
});
