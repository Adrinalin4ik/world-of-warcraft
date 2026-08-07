/**
 * Two assertions, both happy path, and they are deliberately split by what they can be TRUSTED
 * against.
 *
 * The first is the real test character, `Gesf`, with the equipment ids the live server actually sent
 * over `SMSG_CHAR_ENUM` and the `ItemDisplayInfo` rows those ids actually carry. It pins the whole
 * texture half: which slots reach which layers, the priority order inside the ONE tile two of his
 * items share, the destination rects, and the `_M`/`_U` candidate list. Getting any of that wrong
 * fails SILENTLY -- a layer at the wrong tile or in the wrong order still bakes and still draws.
 *
 * The second is a STAGED set, and it has to be: measured, only 11 763 of the 57 986 `ItemDisplayInfo`
 * rows carry any non-zero `geosetGroupIDs`, and every single item on the live test roster carries
 * `[0, 0, 0]`. So the geoset branches and the helm masks cannot be exercised by a real character at
 * all on this account. The rows below are real rows off the live table, assembled onto one character
 * that does not exist.
 */
import { COMPOSITE_TILES } from '../body-composite';
import { bodyLayersFor } from '../character-look';
import {
  ItemDisplayInfoRow,
  REGION_BASES,
  applyHelmetMasks,
  equipGeosetsFor,
  wornEquipmentFor,
} from '../character-equipment';
import { EquipmentDisplay } from '../../../../network/protocol/types';

/** An `ItemDisplayInfo` row with everything empty, so a fixture states only what it carries. */
const row = (id: number, fields: Partial<ItemDisplayInfoRow>): ItemDisplayInfoRow => ({
  id,
  geosetGroupIDs: [0, 0, 0],
  maleHelmetGeosetVisID: 0,
  femaleHelmetGeosetVisID: 0,
  leftModelTexture: '',
  upperArmTexture: '',
  lowerArmTexture: '',
  handsTexture: '',
  upperTorsoTexture: '',
  lowerTorsoTexture: '',
  upperLegTexture: '',
  lowerLegTexture: '',
  footTexture: '',
  ...fields,
});

/** `CharacterRecord.equipment`-shaped: indexed by equipment slot, 23 of them. */
const equipment = (worn: Record<number, number>): EquipmentDisplay[] =>
  Array.from({ length: 23 }, (_unused, slot) => ({
    displayId: worn[slot] ?? 0,
    inventoryType: 0,
    enchantmentId: 0,
  }));

const catalog = (rows: ItemDisplayInfoRow[]) => (displayId: number) =>
  rows.find((candidate) => candidate.id === displayId) ?? null;

const REGION_DIR = 'Item\\TextureComponents';

describe('equipment textures', () => {
  it("orders Gesf's worn regions into the layer list the live rows describe", () => {
    // LIVE, both halves. Equipment slots off `SMSG_CHAR_ENUM` for `Gesf` (level 1 Human male warrior):
    // slot 3 shirt 9891, slot 6 legs 9892, slot 7 feet 10141, slot 15 mainhand 2380. The region names
    // are those four display ids' own `ItemDisplayInfo` rows, read off `dbfilesclient/itemdisplayinfo.dbc`
    // on the live host (57 986 records, 25 fields, 100-byte stride).
    const worn = wornEquipmentFor(
      equipment({ 3: 9891, 6: 9892, 7: 10141, 15: 2380 }),
      catalog([
        row(9891, {
          upperTorsoTexture: 'Leather_A_05Yellow_Chest_TU',
          lowerTorsoTexture: 'Leather_A_05Yellow_Chest_TL',
        }),
        row(9892, {
          upperLegTexture: 'Leather_A_05Yellow_Pant_LU',
          lowerLegTexture: 'Leather_A_05Yellow_Pant_LL',
        }),
        row(10141, {
          lowerLegTexture: 'Leather_A_05Yellow_Boot_LL',
          footTexture: 'Leather_A_05Yellow_Boot_FO',
        }),
        // The two-handed sword. It is slot 15, which is not a bodyslot, so it must contribute NOTHING
        // to the bake -- a weapon is piece 9's attachment, not a body region.
        row(2380, {}),
      ]),
    );

    // No `CharSections` rows, so the body half is empty and the assertion is only the tail this piece
    // adds -- which is the point: the equipment layers are an append and nothing else moves.
    const layers = bodyLayersFor([], 1, 0, null, worn);

    expect(layers).toEqual([
      // TorsoUpper then TorsoLower: the shirt, layer order 3 then 4.
      {
        tile: 'TORSO_UPPER',
        rect: COMPOSITE_TILES.TORSO_UPPER,
        path: `${REGION_DIR}\\TorsoUpperTexture\\Leather_A_05Yellow_Chest_TU_M.blp`,
        alternates: [
          `${REGION_DIR}\\TorsoUpperTexture\\Leather_A_05Yellow_Chest_TU_U.blp`,
          `${REGION_DIR}\\TorsoUpperTexture\\Leather_A_05Yellow_Chest_TU.blp`,
        ],
      },
      {
        tile: 'TORSO_LOWER',
        rect: COMPOSITE_TILES.TORSO_LOWER,
        path: `${REGION_DIR}\\TorsoLowerTexture\\Leather_A_05Yellow_Chest_TL_M.blp`,
        alternates: [
          `${REGION_DIR}\\TorsoLowerTexture\\Leather_A_05Yellow_Chest_TL_U.blp`,
          `${REGION_DIR}\\TorsoLowerTexture\\Leather_A_05Yellow_Chest_TL.blp`,
        ],
      },
      // LegUpper: the trousers. Note the rect IS the pelvis tile (256,192,256,128) -- the underwear
      // layer blits before this one, which is why trousers cover it rather than sit beside it.
      {
        tile: 'LEG_UPPER',
        rect: COMPOSITE_TILES.LEG_UPPER,
        path: `${REGION_DIR}\\LegUpperTexture\\Leather_A_05Yellow_Pant_LU_M.blp`,
        alternates: [
          `${REGION_DIR}\\LegUpperTexture\\Leather_A_05Yellow_Pant_LU_U.blp`,
          `${REGION_DIR}\\LegUpperTexture\\Leather_A_05Yellow_Pant_LU.blp`,
        ],
      },
      // THE ONE THAT MATTERS. Trousers and boots both paint LegLower, and the `[0x803bf8]` priority
      // table stacks pants at 0 and boots at 2 -- so the boot goes on TOP of the trouser leg. Reverse
      // these two and the boots vanish under the trousers with no error anywhere.
      {
        tile: 'LEG_LOWER',
        rect: COMPOSITE_TILES.LEG_LOWER,
        path: `${REGION_DIR}\\LegLowerTexture\\Leather_A_05Yellow_Pant_LL_M.blp`,
        alternates: [
          `${REGION_DIR}\\LegLowerTexture\\Leather_A_05Yellow_Pant_LL_U.blp`,
          `${REGION_DIR}\\LegLowerTexture\\Leather_A_05Yellow_Pant_LL.blp`,
        ],
      },
      {
        tile: 'LEG_LOWER',
        rect: COMPOSITE_TILES.LEG_LOWER,
        path: `${REGION_DIR}\\LegLowerTexture\\Leather_A_05Yellow_Boot_LL_M.blp`,
        alternates: [
          `${REGION_DIR}\\LegLowerTexture\\Leather_A_05Yellow_Boot_LL_U.blp`,
          `${REGION_DIR}\\LegLowerTexture\\Leather_A_05Yellow_Boot_LL.blp`,
        ],
      },
      {
        tile: 'FOOT',
        rect: COMPOSITE_TILES.FOOT,
        path: `${REGION_DIR}\\FootTexture\\Leather_A_05Yellow_Boot_FO_M.blp`,
        alternates: [
          `${REGION_DIR}\\FootTexture\\Leather_A_05Yellow_Boot_FO_U.blp`,
          `${REGION_DIR}\\FootTexture\\Leather_A_05Yellow_Boot_FO.blp`,
        ],
      },
    ]);
  });
});

describe('equipment geosets and helm masks', () => {
  it('takes a robe, gloves, a cloak and a helm to the branches they select', () => {
    // STAGED, and every row is a real one off the live table -- no live character on this account
    // wears anything with a non-zero `geosetGroupIDs`, so this look had to be assembled:
    //   chest  1868  Robe_A_01Black,   geosetGroup [1, 0, 1]  -- the [2] is the ROBE bit
    //   pants  1229  Mail_B_01_Pant,   geosetGroup [2, 0, 0]
    //   boots   703  Leather_A_01_Boot,geosetGroup [3, 0, 0]
    //   gloves  510  Mail_B_01_Glove,  geosetGroup [1, 0, 0]
    //   tabard 3864  Tabard_A_01Lordaeron, geosetGroup [1, 0, 0]
    //   back  13963  Cape_Mage_A_01Black,  geosetGroup [1, 0, 0]
    //   head  14957  Helm_Plate_A_01Crusader, HelmetGeosetVisData row 248 (male)
    const worn = wornEquipmentFor(
      equipment({ 0: 14957, 4: 1868, 6: 1229, 7: 703, 9: 510, 14: 13963, 18: 3864 }),
      catalog([
        row(1868, { geosetGroupIDs: [1, 0, 1] }),
        row(1229, { geosetGroupIDs: [2, 0, 0] }),
        row(703, { geosetGroupIDs: [3, 0, 0] }),
        row(510, { geosetGroupIDs: [1, 0, 0] }),
        row(3864, { geosetGroupIDs: [1, 0, 0] }),
        row(13963, { geosetGroupIDs: [1, 0, 0] }),
        row(14957, { maleHelmetGeosetVisID: 248, femaleHelmetGeosetVisID: 306 }),
      ]),
    );

    // The customization has already written slots 0..3 -- hairstyle 12 and the beard `Gesf` really
    // has (101/201/302, from `CharacterFacialHairStyles` columns 1/2/3).
    const slots = [...REGION_BASES];
    slots[0] = 12;
    slots[1] = 101;
    slots[2] = 201;
    slots[3] = 302;

    // `HelmetGeosetVisData` row 248, verbatim off the live table (21 records, 8 fields, 32-byte
    // stride): every mask is a RACE bitfield, and Human is race 1, so the bit tested is 0x2.
    //   col0 0xffffffbf  hair    -> bit set -> slot 0 forced to 1, the bare scalp
    //   col1 0xffffffdf  facial1 -> bit set -> 101
    //   col2 0xffffffbf  facial2 -> bit set -> 201
    //   col3 0xfffffedf  facial3 -> bit set -> 301, so the 302 beard goes
    //   col4 0xfffffeef  ears    -> bit set -> 701, the tucked ear over the 702 default
    applyHelmetMasks(
      slots,
      worn,
      [{ id: 248, hideGeosets: [0xffffffbf, 0xffffffdf, 0xffffffbf, 0xfffffedf, 0xfffffeef, 0, 0] }],
      1,
      0,
    );
    expect(slots.slice(0, 4)).toEqual([1, 101, 201, 301]);
    expect(slots[7]).toBe(701);

    expect([...equipGeosetsFor(slots, worn)].sort((a, b) => a - b)).toEqual([
      0, // the body, unconditional
      1, // the helm forced the hairstyle back to the bare scalp
      101,
      201,
      301, // the helm forced the beard back to clean
      402, // B1: gloves 401 + 1, and group 4 was range-disabled first
      // 501..599 GONE: the robe disabled the boot group, so boots 703's 501+3 never appears
      601,
      701, // the helm tucked the ear; 702 was overwritten in the slot, not added beside it
      801, // the bare-skin sleeve base. B1 took the GLOVE branch, so the robe's own sleeve (802) is
      // NOT added -- the reference's `if gloves … else if chest sleeves …`, kept as recorded
      901, // the kneepad BASE survives: the robe's disable is 902..999, deliberately sparing 901
      1001,
      // 1101 is GONE, and the asymmetry with 901 above is the reference's, recorded not reasoned: the
      // robe disables 1100..1199, which swallows group 11's own base, where the kneepad disable starts
      // at 902. So a robe leaves the bare kneepad on and takes the bare trouser off.
      1201, // the tabard flap is NOT added (1201 + 1 = 1202): a robe hides it
      1302, // B4: the robe's own skirt, 1301 + 1
      1401,
      1502, // B8: the cloak's 1501 + 1, after group 15 was range-disabled
    ]);
  });
});
