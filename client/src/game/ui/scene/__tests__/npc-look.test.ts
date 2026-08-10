/**
 * ONE assertion, happy path, and it is the one the brief names: a creature display id -> its model
 * path, its texture set and its geoset list.
 *
 * The fixture is a real Stormwind guard rather than an invented row -- `CreatureDisplayInfo` 3167,
 * one of the seventeen humanoid npcs measured standing in Northshire while drawing black. Every value
 * below was read off the live host's own DBCs, and the row was chosen because it exercises the four
 * things that make the humanoid path different from the creature path in one go:
 *
 *  - `extraInfoID` 346 is non-zero, so the row is a CHARACTER model and the raw texture-variation
 *    columns it does not have are not the answer;
 *  - `BakeName` supplies the body atlas, which is why no compositor runs;
 *  - the helm's `HelmetGeosetVisData` row 248 has bits set for race 1 in all five implemented mask
 *    columns, so the ear slot must move 702 -> 701;
 *  - three items carry a non-zero `geosetGroupIDs[0]` -- gloves 7698, boots 7255 and tabard 6255 --
 *    so the gloves branch must DISABLE 401 and add 402 while the boots branch ADDS 502 beside the
 *    naked 501, which is the client's own asymmetry and the easiest thing in the port to get wrong.
 */
import { resolveNpcLook } from '../npc-look';

const TABLES: Record<string, { records: any[] }> = {
  CreatureDisplayInfoExtra: {
    records: [
      // Row 346 verbatim: race 1, male, every appearance dial 0, and the eleven item columns.
      {
        id: 346,
        raceID: 1,
        gender: 0,
        skinColor: 0,
        faceType: 0,
        hairStyle: 0,
        hairColor: 0,
        facialHair: 0,
        helmID: 14964,
        shoulderID: 7541,
        shirtID: 7223,
        cuirassID: 0,
        beltID: 7224,
        legsID: 7225,
        bootsID: 7255,
        wristID: 0,
        glovesID: 7698,
        tabardID: 6255,
        capeID: 0,
        texture: '753720ae579b4cf6a14b8c8e39b36b34.blp',
      },
    ],
  },
  ChrRaces: { records: [{ id: 1, maleDisplayID: 49, femaleDisplayID: 50, clientPrefix: 'Hu' }] },
  CharSections: {
    records: [
      // BaseSection 3, Human Male VariationIndex 0 -- the bald row, whose three texture columns are
      // empty in the real table. So `hairTexture` is null here and that is the DATA, not a miss.
      { raceID: 1, gender: 0, generalType: 3, textures: ['', '', ''], flags: 17, type: 0, variation: 0 },
    ],
  },
  CharHairGeosets: {
    // Variation 0 -> geoset 0 / ShowScalp 1; `max(1, geoset)` makes that the bald scalp cap, 1.
    records: [{ raceID: 1, gender: 0, hairType: 0, geoset: 0, bald: true }],
  },
  CharacterFacialHairStyles: {
    records: [{ raceID: 1, gender: 0, specificID: 0, geosetIDs: [1, 1, 1, 0, 0] }],
  },
  HelmetGeosetVisData: {
    // Row 248's seven mask columns, verbatim. Race 1's bit (0x02) is set in columns 0..4.
    records: [
      { id: 248, hideGeosets: [4294967231, 4294967263, 4294967231, 4294967007, 4294967023, 0, 0] },
    ],
  },
  ItemDisplayInfo: {
    records: [
      { id: 14964, geosetGroupIDs: [0, 0, 0], maleHelmetGeosetVisID: 248, femaleHelmetGeosetVisID: 306, leftModelFile: 'Helm_Plate_B_01Stormwind.mdx', leftModelTexture: 'Helm_Plate_B_01Stormwind' },
      { id: 7541, geosetGroupIDs: [0, 0, 0], leftModelFile: 'LShoulder_Plate_B_01.mdx', leftModelTexture: 'Shoulder_Plate_B_01Stormwind' },
      { id: 7223, geosetGroupIDs: [0, 0, 0] },
      { id: 7224, geosetGroupIDs: [0, 0, 0] },
      { id: 7225, geosetGroupIDs: [0, 0, 0] },
      { id: 7255, geosetGroupIDs: [1, 0, 0] },
      { id: 7698, geosetGroupIDs: [1, 0, 0] },
      { id: 6255, geosetGroupIDs: [1, 0, 0] },
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
        // The real `pipeline/dbc/index.js#index` writes every record onto the table object under its
        // own id as well as into `records`, and `resolveNpcEquipment` reads `ItemDisplayInfo` that
        // way -- a property read, not a scan of 57 986 rows. The fake has to do both or the
        // equipment half of this assertion is silently skipped.
        table.records.forEach((record) => {
          (table as any)[record.id] = record;
        });
        return Promise.resolve(table);
      }
      return Promise.resolve(table.records.find((record) => record.id === id));
    },
  },
}));

describe('resolveNpcLook', () => {
  it('takes a humanoid display id to its model, its baked body atlas and its geosets', async () => {
    const look = await resolveNpcLook(
      { extraInfoID: 346, scale: 1 },
      { file: 'Character\\Human\\Male\\HumanMale.mdx', collisionHeight: 2.031 },
    );

    expect(look).toMatchObject({
      modelPath: 'Character\\Human\\Male\\HumanMale.mdx',
      // THE POINT OF THE WHOLE PATH: the body texture is the pre-baked atlas the game data ships,
      // bound straight into texture type 1 -- not a composite, and not the `null` that drew black.
      bodyTexture: 'Textures\\BakedNpcTextures\\753720ae579b4cf6a14b8c8e39b36b34.blp',
      // Empty, so `loadCharacter` bakes nothing at all. See `resolveNpcLook`.
      bodyLayers: [],
      hairTexture: null,
      capeTexture: null,
      scale: 1,
    });

    expect([...look!.geosets].sort((a, b) => a - b)).toEqual([
      0, 1, 101, 201, 301, 402, 501, 502, 601, 701, 801, 901, 1001, 1101, 1201, 1202, 1301, 1401,
      1501,
    ]);

    // The helm and the left pauldron. The helm is per-race-and-sex (`_HuM`, from `ChrRaces`'
    // `clientPrefix`) and is respelled `.m2` because the suffix is synthesised; the pauldron keeps
    // the `.mdx` the DBC spells, which `M2Blueprint.load` rewrites. Nothing is held:
    // `CreatureDisplayInfoExtra` has no weapon columns.
    expect(look!.attachments.map((item) => item.modelPath)).toEqual([
      'Item\\ObjectComponents\\Head\\Helm_Plate_B_01Stormwind_HuM.m2',
      'Item\\ObjectComponents\\Shoulder\\LShoulder_Plate_B_01.mdx',
    ]);
  });
});
