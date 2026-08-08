/**
 * Two assertions, both happy path.
 *
 * The FIRST is the one that matters and the one the whole piece turns on: appearance values -> the
 * ordered layer list, paths and destination rects. That is the part that goes wrong SILENTLY --
 * every mistake available in it (the hair column shift, the per-section colour key, the order of two
 * layers that share a tile) produces a bake that runs, uploads and draws, and is wrong only on a
 * face at 3x zoom. The fixture rows are the real ones read out of `CharSections.dbc` in §1 of
 * `docs/superpowers/research/2026-08-07-compositor-measurements.md`, for the owner's own character
 * (Gesf: Human male, skin 0 / face 4 / hairStyle 11 / hairColor 5 / facialHair 1), and the expected
 * list is that section's eight-row table.
 *
 * The SECOND pins the tile arithmetic and the per-layer mip shift by baking a real buffer: a
 * vanilla-era 128x32 scalp layer has to land point-DOUBLED across the whole of a 256x64 tile at
 * (0,320), and nothing outside that rect may move. That is the other thing a screenshot cannot tell
 * you: a rect off by a factor of two still draws.
 *
 * The fixture's texture columns are the FILE NAMES §1 measured. The real DBC carries full paths
 * (`Character\Human\Male\HumanMaleSkin00_00.blp`); the compositor passes whatever the column holds
 * through untouched, so the distinction does not reach the code under test.
 */
import { bodyLayersFor, CharSectionsRow } from '../character-look';
import { compositeBody } from '../body-composite';

// `enqueueAt` delegates to `enqueue` with the priority dropped, so every expectation below keeps
// reading `(kind, path)` at the positions it always did. The bake asks at CHARACTER priority (see
// `worker/pool.js#PRIORITY`); WHICH priority is a scheduling decision the pool owns and tests, and
// is not what this suite is about.
jest.mock('../../../pipeline/worker/pool', () => {
  const enqueue = jest.fn();
  return {
    __esModule: true,
    PRIORITY: { BACKGROUND: 0, CHARACTER: 1 },
    default: {
      enqueue,
      enqueueAt: (_priority: number, ...args: unknown[]) => enqueue(...args),
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WorkerPool = require('../../../pipeline/worker/pool').default;

/**
 * The five `CharSections` rows Gesf's appearance selects, measured. Column names are the repo
 * schema's: `type` is really VariationIndex and `variation` is really ColorIndex (research §2.2), and
 * `generalType` is BaseSection.
 */
const ROWS: CharSectionsRow[] = [
  {
    raceID: 1, gender: 0, generalType: 0, flags: 17, type: 0, variation: 0,
    textures: ['HumanMaleSkin00_00.blp', '', ''],
  },
  {
    raceID: 1, gender: 0, generalType: 1, flags: 1, type: 4, variation: 0,
    textures: ['HumanMaleFaceLower04_00.blp', 'HumanMaleFaceUpper04_00.blp', ''],
  },
  {
    raceID: 1, gender: 0, generalType: 2, flags: 17, type: 1, variation: 5,
    textures: ['FacialLowerHair01_05.blp', 'FacialUpperHair01_05.blp', ''],
  },
  {
    raceID: 1, gender: 0, generalType: 3, flags: 17, type: 11, variation: 5,
    // `[0]` is the hair MESH sheet (texture type 6) and must NOT appear in the bake.
    textures: ['Hair02_05.blp', 'ScalpLowerHair02_05.blp', 'ScalpUpperHair02_05.blp'],
  },
  {
    raceID: 1, gender: 0, generalType: 4, flags: 17, type: 0, variation: 0,
    textures: ['HumanMaleNakedPelvisSkin00_00.blp', '', ''],
  },
];

const GESF = { skin: 0, face: 4, hairStyle: 11, hairColor: 5, facialHair: 1 };

test("an appearance resolves to the reference's layer order, with the measured tiles", () => {
  expect(bodyLayersFor(ROWS, 1, 0, GESF)).toEqual([
    { tile: 'BODY', rect: [0, 0, 512, 512], path: 'HumanMaleSkin00_00.blp' },
    { tile: 'HEAD_LOWER', rect: [0, 384, 256, 128], path: 'HumanMaleFaceLower04_00.blp' },
    { tile: 'HEAD_UPPER', rect: [0, 320, 256, 64], path: 'HumanMaleFaceUpper04_00.blp' },
    { tile: 'HEAD_LOWER', rect: [0, 384, 256, 128], path: 'FacialLowerHair01_05.blp' },
    { tile: 'HEAD_UPPER', rect: [0, 320, 256, 64], path: 'FacialUpperHair01_05.blp' },
    { tile: 'HEAD_LOWER', rect: [0, 384, 256, 128], path: 'ScalpLowerHair02_05.blp' },
    { tile: 'HEAD_UPPER', rect: [0, 320, 256, 64], path: 'ScalpUpperHair02_05.blp' },
    { tile: 'PELVIS', rect: [256, 192, 256, 128], path: 'HumanMaleNakedPelvisSkin00_00.blp' },
  ]);
});

/** A BLP spec as the worker returns one: opaque `[r,g,b]`, with the authored mip chain. */
function spec(width: number, height: number, [r, g, b]: [number, number, number]) {
  const mipmaps = [];
  for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    mipmaps.push({ width: w, height: h, data });
    if (w === 1 && h === 1) {
      break;
    }
  }
  // `format: 2` is IMAGE_ABGR8888 -- what all 38 measured sources actually came back as.
  return { width, height, format: 2, mipmaps };
}

test('the scalp layer point-doubles into its 256x64 tile and touches nothing else', async () => {
  const GREY: [number, number, number] = [128, 128, 128];
  const RED: [number, number, number] = [255, 0, 0];
  WorkerPool.enqueue.mockImplementation((_kind: string, path: string) =>
    Promise.resolve(
      path.includes('SCALPUPPER') ? spec(128, 32, RED) : spec(512, 512, GREY),
    ),
  );

  const baked = await compositeBody([
    { tile: 'BODY', rect: [0, 0, 512, 512], path: 'HumanMaleSkin00_00.blp' },
    { tile: 'HEAD_UPPER', rect: [0, 320, 256, 64], path: 'ScalpUpperHair02_05.blp' },
  ]);

  expect(baked).not.toBeNull();
  const texture = baked!.texture;
  expect([texture.image.width, texture.image.height]).toEqual([512, 512]);
  // 512 -> 1 is ten authored levels, and the base skin ships all ten.
  expect(texture.mipmaps.length).toBe(10);

  const level0 = texture.image.data as Uint8Array;
  const at = (x: number, y: number) => Array.from(level0.subarray((y * 512 + x) * 4, (y * 512 + x) * 4 + 4));
  // The tile's four corners, all red: 128x32 source doubled fills 256x64 at (0,320).
  expect(at(0, 320)).toEqual([255, 0, 0, 255]);
  expect(at(255, 320)).toEqual([255, 0, 0, 255]);
  expect(at(0, 383)).toEqual([255, 0, 0, 255]);
  expect(at(255, 383)).toEqual([255, 0, 0, 255]);
  // One texel outside each edge: still the base skin.
  expect(at(256, 320)).toEqual([128, 128, 128, 255]);
  expect(at(0, 319)).toEqual([128, 128, 128, 255]);
  expect(at(0, 384)).toEqual([128, 128, 128, 255]);
  // Dest level 1 is the scalp's OWN authored level 0 at 1:1 -- the shift, not a resample: the tile
  // there is (0,160,128,32), so (127,191) is its bottom-right corner and (128,160) is outside.
  const level1 = (texture.mipmaps[1] as { data: Uint8Array }).data;
  const at1 = (x: number, y: number) => Array.from(level1.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4));
  expect(at1(127, 191)).toEqual([255, 0, 0, 255]);
  expect(at1(128, 160)).toEqual([128, 128, 128, 255]);
});
