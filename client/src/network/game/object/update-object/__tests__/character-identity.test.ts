/**
 * ONE assertion, happy path: a player's update-object FIELDS reach the same look the roster does.
 *
 * The same shape the glue-side test asserts (`ui/scene/__tests__/character-look.test.ts`) and
 * deliberately the whole chain rather than the byte unpacking alone -- `characterIdentityFor` ->
 * `resolveCharacterLook` -> model path, geoset set and composite layer list -- because the point of
 * this piece is that the WORLD reuses the glue path rather than growing a second one. A test of the
 * bit shifts alone would still pass on the day someone forked the resolver.
 *
 * THE FIXTURE IS THE REAL SERVER'S. `Gesf` is a Human male, skin 0 / face 4 / hairStyle 11 /
 * hairColor 5 / facialHair 1, and the field words below are those dials packed exactly as
 * `Player::Create` packs them. His trousers are item 9892; its `Item.dbc` row's `displayInfoID` is what
 * turns an update-object ENTRY id into the DISPLAY id `ItemDisplayInfo` is keyed by, which is the one
 * thing the wire cannot hand over and the roster can.
 */
import { characterIdentityFor } from '../character-identity';
import { resolveCharacterLook } from '../../../../../game/ui/scene/character-look';

const TABLES: Record<string, { records: any[] }> = {
  ChrRaces: { records: [{ id: 1, maleDisplayID: 49, femaleDisplayID: 50, clientPrefix: 'Hu' }] },
  CreatureDisplayInfo: { records: [{ id: 49, modelID: 49, scale: 1 }] },
  CreatureModelData: {
    records: [{ id: 49, file: 'Character\\Human\\Male\\HumanMale.mdx', collisionHeight: 2.03 }],
  },
  CharSections: {
    records: [
      // BaseSection 0, ColorIndex 0 -- the base skin, i.e. the composite's canvas.
      {
        raceID: 1,
        gender: 0,
        generalType: 0,
        textures: ['Character\\Human\\Male\\HumanMaleSkin00_00.blp', '', ''],
        flags: 17,
        type: 0,
        variation: 0,
      },
      // BaseSection 3 (hair), VariationIndex 11 / ColorIndex 5 -- the blonde of the ten.
      {
        raceID: 1,
        gender: 0,
        generalType: 3,
        textures: [
          'Character\\Human\\Hair02_05.blp',
          'Character\\Human\\ScalpLowerHair02_05.blp',
          'Character\\Human\\ScalpUpperHair02_05.blp',
        ],
        flags: 17,
        type: 11,
        variation: 5,
      },
    ],
  },
  CharHairGeosets: {
    records: [{ raceID: 1, gender: 0, hairType: 11, geoset: 12, bald: false }],
  },
  CharacterFacialHairStyles: {
    records: [{ raceID: 1, gender: 0, specificID: 1, geosetIDs: [1, 2, 1, 0, 0] }],
  },
  // Entry -> display id. The bridge the update-object needs and `SMSG_CHAR_ENUM` does not.
  // 9892 is Gesf's live trousers; `inventorySlotID` 7 is EQUIPMENT_SLOT_LEGS' inventory type.
  Item: { records: [{ id: 9892, displayInfoID: 9892, inventorySlotID: 7 }] },
  ItemDisplayInfo: {
    records: [
      {
        id: 9892,
        // `geosetGroupIDs[1] = 2` is the trousers' kneepad variant, which `equipGeosetsFor`'s B4 branch
        // adds off the 901 base -- geoset 903.
        geosetGroupIDs: [0, 2, 0],
        upperLegTexture: 'Leather_Horde_A_01Yellow_Pant_LU',
        lowerLegTexture: 'Leather_Horde_A_01Yellow_Pant_LL',
      },
    ],
  },
};

jest.mock('../../../../../game/pipeline/dbc', () => ({
  __esModule: true,
  default: {
    load: (name: string, id?: number) => {
      const table = TABLES[name];
      if (!table) {
        throw new Error(`the fake DBC layer has no table "${name}"`);
      }
      if (id === undefined) {
        // `DBC.load(name)` answers the whole table, and the real one indexes its records by id ONTO
        // itself (`pipeline/dbc/index.js#index`) -- which both `characterIdentityFor` and
        // `resolveWornEquipment` read as a property, so the fake has to do it too.
        const indexed: any = { records: table.records };
        for (const record of table.records) {
          indexed[record.id] = record;
        }
        return Promise.resolve(indexed);
      }
      return Promise.resolve(table.records.find((record) => record.id === id));
    },
  },
}));

describe('a player object in the world', () => {
  it('takes its appearance and equipment fields to the same look the roster resolves', async () => {
    const identity = await characterIdentityFor({
      // race 1 | class 1 << 8 | gender 0 << 16 | powerType 1 << 24
      unit_field_bytes_0: 1 | (1 << 8) | (0 << 16) | (1 << 24),
      // skin 0 | face 4 << 8 | hairStyle 11 << 16 | hairColor 5 << 24, unsigned
      player_bytes: (0 | (4 << 8) | (11 << 16) | (5 << 24)) >>> 0,
      player_bytes_2: 1, // facialHair, byte 0
      unit_field_displayid: 49,
      // EQUIPMENT_SLOT_LEGS is 6, so the field is numbered 7.
      player_visible_item_7_entryid: 9892,
    });

    expect(identity).toMatchObject({
      race: 1,
      gender: 0,
      appearance: { skin: 0, face: 4, hairStyle: 11, hairColor: 5, facialHair: 1 },
    });
    expect(identity!.equipment[6]).toEqual({ displayId: 9892, inventoryType: 7, enchantmentId: 0 });

    const look = await resolveCharacterLook(identity!);

    expect(look).toMatchObject({
      modelPath: 'Character\\Human\\Male\\HumanMale.mdx',
      scale: 1,
      hairTexture: 'Character\\Human\\Hair02_05.blp',
    });

    // The geosets: the unconditional body, hairstyle 12 (NOT 11 -- the dial is not the geoset id), the
    // facial-hair triple under the measured column order, and the trousers' kneepad variant 903.
    expect(look!.geosets.has(0)).toBe(true);
    expect(look!.geosets.has(12)).toBe(true);
    expect([...look!.geosets].filter((id) => id >= 100 && id < 400).sort()).toEqual([101, 201, 302]);
    expect(look!.geosets.has(903)).toBe(true);

    // The composite layer list: the base skin's canvas, both scalp tiles, and the trousers' two region
    // tiles resolved from `Item.dbc`'s display id. This is the list `body-composite.ts` blits.
    expect(look!.bodyLayers.map((layer) => layer.path)).toEqual([
      'Character\\Human\\Male\\HumanMaleSkin00_00.blp',
      'Character\\Human\\ScalpLowerHair02_05.blp',
      'Character\\Human\\ScalpUpperHair02_05.blp',
      'Item\\TextureComponents\\LegUpperTexture\\Leather_Horde_A_01Yellow_Pant_LU_M.blp',
      'Item\\TextureComponents\\LegLowerTexture\\Leather_Horde_A_01Yellow_Pant_LL_M.blp',
    ]);
  });
});
