/**
 * ONE assertion, happy path, and it is the one the brief asks for: an equipped item -> its model path,
 * its attachment id, and its transform.
 *
 * Everything in it is REAL SERVER BYTES, which is unusual for this milestone and worth saying plainly.
 * The equipment slots and inventory types are `SMSG_CHAR_ENUM` as the live server sent it for three of
 * the five roster characters; the `ItemDisplayInfo` model and texture columns are those display ids'
 * own rows off `dbfilesclient/itemdisplayinfo.dbc` (57 986 records, 25 fields, 100-byte stride); and the
 * attachment positions and bone pivots are a direct dump of `Character\Human\Male\HumanMale.m2`
 * (version 264, 1 585 376 bytes, 138 bones, 39 attachment records). Nothing here is staged.
 *
 * The three behaviours it pins, all of which fail silently:
 *  - a mainhand goes to attachment **1** (the right hand) whether it is a two-hander or a one-hander,
 *  - an offhand SHIELD goes to attachment **0** (the left forearm) and not to the left hand,
 *  - a RANGED weapon draws nothing at all on this screen -- the melee-drawn sheath state has no ranged
 *    arm, so a bow is absent rather than misplaced.
 * Plus the transform: the bone-local offset, in engine axes, with its sign convention.
 */
import { attachmentLocalOffset } from '../../../pipeline/m2/anim/axes';
import {
  ATTACH_HAND_RIGHT,
  ATTACH_SHIELD,
  attachedItemsFor,
} from '../character-attachments';
import { ItemDisplayInfoRow, wornEquipmentFor } from '../character-equipment';
import { EquipmentDisplay } from '../../../../network/protocol/types';

/** An `ItemDisplayInfo` row with everything empty, so a fixture states only what it carries. */
const row = (id: number, fields: Partial<ItemDisplayInfoRow>): ItemDisplayInfoRow => ({
  id,
  geosetGroupIDs: [0, 0, 0],
  maleHelmetGeosetVisID: 0,
  femaleHelmetGeosetVisID: 0,
  leftModelFile: '',
  rightModelFile: '',
  leftModelTexture: '',
  rightModelTexture: '',
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
const equipment = (worn: Record<number, [number, number]>): EquipmentDisplay[] =>
  Array.from({ length: 23 }, (_unused, slot) => ({
    displayId: worn[slot]?.[0] ?? 0,
    inventoryType: worn[slot]?.[1] ?? 0,
    enchantmentId: 0,
  }));

const catalog = (rows: ItemDisplayInfoRow[]) => (displayId: number) =>
  rows.find((candidate) => candidate.id === displayId) ?? null;

describe('character attachments', () => {
  it('hangs the live held items on the points the real M2 carries', () => {
    // LIVE. `Gesf` slot 15 = display 2380, inventoryType 17 (TWOHAND). `Sgh` slot 16 = display 18730,
    // inventoryType 14 (SHIELD). `Aag` slot 17 = display 8106, inventoryType 15 (RANGED, a short bow).
    // Assembled onto one character only so the three branches are one assertion; each row and each
    // inventory type is exactly what the server sent for the character named.
    const worn = wornEquipmentFor(
      equipment({ 15: [2380, 17], 16: [18730, 14], 17: [8106, 15] }),
      catalog([
        row(2380, {
          leftModelFile: 'Sword_2H_Claymore_A_01.mdx',
          leftModelTexture: 'Sword_2H_Claymore_A_01Rusty',
        }),
        row(18730, {
          leftModelFile: 'Shield_Round_A_01.mdx',
          leftModelTexture: 'Buckler_Damaged_A_01Purple',
        }),
        row(8106, {
          leftModelFile: 'Bow_1H_Short_A_01.mdx',
          leftModelTexture: 'Bow_1H_Short_A_01Red',
        }),
      ]),
    );

    // `Hu` is `ChrRaces` field 6 for race 1; only a helm reads it, and this look wears none.
    expect(attachedItemsFor(worn, 'Hu', 0)).toEqual([
      {
        attachId: ATTACH_HAND_RIGHT,
        modelPath: 'Item\\ObjectComponents\\Weapon\\Sword_2H_Claymore_A_01.mdx',
        texturePath: 'Item\\ObjectComponents\\Weapon\\Sword_2H_Claymore_A_01Rusty.blp',
        kind: 'weapon',
      },
      {
        // The LEFT FOREARM, not the left hand -- a shield is the one offhand that is not held.
        attachId: ATTACH_SHIELD,
        modelPath: 'Item\\ObjectComponents\\Shield\\Shield_Round_A_01.mdx',
        // Note the texture name is a BUCKLER on a round-shield mesh: the two columns are independent
        // and neither is derivable from the other.
        texturePath: 'Item\\ObjectComponents\\Shield\\Buckler_Damaged_A_01Purple.blp',
        kind: 'shield',
      },
      // The bow is ABSENT, which is the third assertion and the easiest one to lose: character select
      // draws the melee sheath state, whose ranged arm never yields a point.
    ]);

    // The transform. `HumanMale.m2` attachment id 1 sits on bone 125 at raw `[-0.0585, -0.4757,
    // 0.9041]`, and bone 125's own `pivotPoint` is the same three floats to every digit the file
    // carries -- so the bone-local offset is zero and the item's origin is the grip.
    //
    // Per component and not `toEqual([0, 0, 0])`: `-(x - x)` is negative zero, which Jest's structural
    // equality distinguishes from positive zero. It is the same point either way, and asserting the
    // sign of a zero would be pinning an artefact of the arithmetic rather than the placement.
    attachmentLocalOffset([-0.0585, -0.4757, 0.9041], [-0.0585, -0.4757, 0.9041]).forEach((v) => {
      expect(v).toBeCloseTo(0, 10);
    });

    // And the sign convention, which the zero above cannot show. A hypothetical record one tenth ahead
    // of its bone on each axis mirrors X and Y and leaves Z alone -- the engine's `D = diag(-1, -1, 1)`.
    expect(attachmentLocalOffset([0.1, 0.2, 0.3], [0, 0, 0])).toEqual([-0.1, -0.2, 0.3]);
  });
});
