/**
 * Two assertions, both happy path.
 *
 * The first is the one that matters: race + gender -> model path. Everything else about drawing a
 * character is downstream of getting that pair right, and it is the one link with a measured trap in
 * it -- `maleDisplayID` and `femaleDisplayID` are two independent `ChrRaces` columns, and Blood Elf
 * ships them out of order (male 15476, female 15475), so any implementation that derives one from the
 * other passes for Human and fails for a race that is in the game. The fixture rows below are the
 * real ones, read off `dbfilesclient/chrraces.dbc` on the live host.
 *
 * The second pins geoset selection, which is the whole reason a character does not draw wearing all
 * twelve of its hairstyles at once -- and pins it against DUPLICATE partIDs, which the measured skin
 * has (7 of them) and which the `M2#parts` map cannot represent.
 */
import M2 from '../../../pipeline/m2';
import { resolveCharacterLook } from '../character-look';
import { CharacterRecord } from '../../../../network/protocol/types';

/**
 * The four tables `resolveCharacterLook` reads, with the real measured rows for Human.
 *
 * `DBC.load(name)` answers the whole table; `DBC.load(name, id)` answers one record by id -- the two
 * shapes the real `pipeline/dbc/index.js` has, so the fake has both.
 */
const TABLES: Record<string, { records: any[] }> = {
  ChrRaces: {
    records: [
      // ChrRaces fields 0, 4, 5. Both Human display ids, and Blood Elf's out-of-order pair.
      { id: 1, maleDisplayID: 49, femaleDisplayID: 50 },
      { id: 10, maleDisplayID: 15476, femaleDisplayID: 15475 },
    ],
  },
  CreatureDisplayInfo: {
    records: [
      { id: 49, modelID: 49, scale: 1 },
      { id: 50, modelID: 50, scale: 1 },
    ],
  },
  CreatureModelData: {
    records: [
      { id: 49, file: 'Character\\Human\\Male\\HumanMale.mdx' },
      { id: 50, file: 'Character\\Human\\Female\\HumanFemale.mdx' },
    ],
  },
  CharSections: {
    records: [
      // BaseSection 0, flags 17, ColorIndex 0 -- the first player-eligible skin of each Human sex.
      {
        raceID: 1,
        gender: 0,
        generalType: 0,
        textures: ['Character\\Human\\Male\\HumanMaleSkin00_00.blp', '', ''],
        flags: 17,
        variation: 0,
      },
      {
        raceID: 1,
        gender: 1,
        generalType: 0,
        textures: ['Character\\Human\\Female\\HumanFemaleSkin00_00.blp', '', ''],
        flags: 17,
        variation: 0,
      },
    ],
  },
};

jest.mock('../../../pipeline/dbc', () => ({
  __esModule: true,
  default: {
    load: (name: string, id?: number) => {
      const table = TABLES[name];
      if (!table) {
        throw new Error(`the fake DBC layer has no table "${name}"`);
      }
      if (id === undefined) {
        return Promise.resolve(table);
      }
      return Promise.resolve(table.records.find((record) => record.id === id));
    },
  },
}));

const character = (race: number, gender: number): CharacterRecord =>
  ({
    race,
    gender,
    appearance: { skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 },
  } as CharacterRecord);

describe('resolveCharacterLook', () => {
  it('takes race and gender to their own model path and body skin', async () => {
    await expect(resolveCharacterLook(character(1, 0))).resolves.toMatchObject({
      modelPath: 'Character\\Human\\Male\\HumanMale.mdx',
      bodyTexture: 'Character\\Human\\Male\\HumanMaleSkin00_00.blp',
      scale: 1,
    });

    // The SAME race, the other gender: a different display id, a different `.m2`, a different skin.
    await expect(resolveCharacterLook(character(1, 1))).resolves.toMatchObject({
      modelPath: 'Character\\Human\\Female\\HumanFemale.mdx',
      bodyTexture: 'Character\\Human\\Female\\HumanFemaleSkin00_00.blp',
    });
  });
});

describe('M2#setVisibleGeosets', () => {
  it('shows only the named geosets, duplicate partIDs included', () => {
    // Two submeshes carrying partID 0 -- the body and the scalp cap, as `humanmale00.skin` ships
    // them -- plus one hairstyle and one glove variant.
    const submeshes = [0, 0, 3, 402].map((partID) => ({ visible: false, userData: { partID } }));
    const m2 = Object.assign(Object.create(M2.prototype), { submeshes });

    m2.setVisibleGeosets(new Set([0, 401]));
    expect(submeshes.map((s) => s.visible)).toEqual([true, true, false, false]);

    m2.setVisibleGeosets(null);
    expect(submeshes.map((s) => s.visible)).toEqual([true, true, true, true]);
  });
});
