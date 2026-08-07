/**
 * One assertion, happy path, on the real test character.
 *
 * `Gesf`, with the equipment ids the live server actually sent over `SMSG_CHAR_ENUM` and the
 * `ItemDisplayInfo` rows those ids actually carry. It pins the whole texture half: which slots reach
 * which layers, the priority order inside the ONE tile two of his items share, the destination rects,
 * and the `_M`/`_U` candidate list. Getting any of that wrong fails SILENTLY -- a layer at the wrong
 * tile or in the wrong order still bakes and still draws, just wrong.
 */
import { COMPOSITE_TILES } from '../body-composite';
import { bodyLayersFor } from '../character-look';
import { ItemDisplayInfoRow, wornEquipmentFor } from '../character-equipment';
import { EquipmentDisplay } from '../../../../network/protocol/types';

/** An `ItemDisplayInfo` row with everything empty, so a fixture states only what it carries. */
const row = (id: number, fields: Partial<ItemDisplayInfoRow>): ItemDisplayInfoRow => ({
  id,
  geosetGroupIDs: [0, 0, 0],
  maleHelmetGeosetVisID: 0,
  femaleHelmetGeosetVisID: 0,
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
