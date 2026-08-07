/**
 * What the character is WEARING: the eight `ItemDisplayInfo` region textures that composite into the
 * body atlas.
 *
 * A port of the reference's `CharSections::composite_body` equipment half
 * (`benilla-formats/src/characters/sections.rs:222-240`, tables at `:36-76`) with the tile numbers
 * doubled for the 512 canvas and every DBC claim re-read on 3.3.5a data rather than inherited. Where
 * 3.3.5a disagrees with the reference it is said so at the point of disagreement.
 *
 * WHAT IS NOT HERE YET: the GEOSET half. An item can change the mesh as well as the texture -- gloves
 * replace the hand, a robe replaces the legs, a helm hides the hair -- and that is `ItemDisplayInfo`'s
 * `geosetGroupIDs` and `HelmetGeosetVisData` through the client's eight branches, which is the
 * separable second half and lands next. `WornEquipment` below already carries the helm and the cloak,
 * which contribute NO body region, precisely because those two exist only for that half.
 *
 * WHY IT IS A SEPARATE FILE FROM `character-look.ts`. That file is the appearance dials -- five bytes
 * from `SMSG_CHAR_ENUM` against `CharSections`. This one is the worn items -- 23 equipment slots
 * against `ItemDisplayInfo`, a 6.7 MB table with an entirely different shape. They meet in one place,
 * `bodyLayersFor`, which appends these layers to its own.
 */
import { BodyLayer, COMPOSITE_TILES, EQUIP_TILE_NAMES } from './body-composite';
import { EquipmentDisplay } from '../../../network/protocol/types';

/**
 * One `ItemDisplayInfo` row, as much of it as dressing a character needs. Column positions are the
 * existing schema's (`wow-data-parser/dbc/entities/item-display-info.js`), verified against the live
 * table: 57 986 records, 25 fields, 100-byte stride, and reading fields 15..22 as the region names
 * yields `Leather_A_05Yellow_Chest_TU` and friends for the ids the live server actually sent.
 */
export type ItemDisplayInfoRow = {
  id: number;
  /** Fields 7..9. The equipment branches' selectors; `[0, 0, 0]` for an item that adds no mesh. */
  geosetGroupIDs: number[];
  /** Fields 13/14 -- a `HelmetGeosetVisData` row id per sex. 0 = this item hides nothing. */
  maleHelmetGeosetVisID: number;
  femaleHelmetGeosetVisID: number;
  upperArmTexture: string;
  lowerArmTexture: string;
  handsTexture: string;
  upperTorsoTexture: string;
  lowerTorsoTexture: string;
  upperLegTexture: string;
  lowerLegTexture: string;
  footTexture: string;
};

/**
 * The eight region-name columns in LAYER ORDER -- column *i* is compositor layer *i* is
 * `EQUIP_TILE_NAMES[i]`. The identity is the reference's load-bearing one (`sections.rs:36-37`), and
 * the column names here are the repo schema's, which happen to spell the same eight regions the
 * on-disk directories do.
 */
const REGION_COLUMNS = [
  'upperArmTexture',
  'lowerArmTexture',
  'handsTexture',
  'upperTorsoTexture',
  'lowerTorsoTexture',
  'upperLegTexture',
  'lowerLegTexture',
  'footTexture',
] as const satisfies readonly (keyof ItemDisplayInfoRow)[];

/**
 * The `Item\TextureComponents\` sub-directory per layer (`sections.rs:52-60`). Confirmed on the live
 * host: all eight directories answer, and a 508-name stratified sample across them resolved 496 files.
 */
const EQUIP_TEX_DIRS = [
  'ArmUpperTexture',
  'ArmLowerTexture',
  'HandTexture',
  'TorsoUpperTexture',
  'TorsoLowerTexture',
  'LegUpperTexture',
  'LegLowerTexture',
  'FootTexture',
] as const;

/**
 * The eight **bodyslots** the composite and the geoset branches are indexed by, and the
 * `SMSG_CHAR_ENUM` equipment-slot index each one reads.
 *
 * `CharacterRecord.equipment` is an array indexed by equipment slot (`world-wire.ts:138-142` fills 23
 * of them in order), so this is a plain projection and no `inventoryType` mapping is needed on this
 * path -- the same thing the reference says of its own select pipeline
 * (`entities/equipment/mod.rs:144-146`, `attach/glue_preview.rs:41-44`).
 *
 * The ORDER is the client's bodyslot 2..9 order, which is what indexes `EQUIP_LAYER_PRIORITY`'s rows:
 * shirt, chest, belt, pants, boots, wrist, gloves, tabard.
 */
export const BODYSLOT_ENUM_SLOTS = [3, 4, 5, 6, 7, 8, 9, 18] as const;

/** The three `SMSG_CHAR_ENUM` slots that are not bodyslots but still change what is drawn. */
export const ENUM_SLOT_HELM = 0;
export const ENUM_SLOT_CLOAK = 14;

/**
 * The client's `[0x803bf8]` bodyslot x layer stacking table, transcribed from the reference
 * (`sections.rs:66-76`), which reverse-engineered it out of the binary. Rows are the eight bodyslots
 * above, columns the eight layers; the value is the order a slot's contribution stacks at within the
 * layer's tile (ascending blits later, so higher sits on top), and `-1` means the slot never touches
 * that layer.
 *
 * THIS IS THE ONE TABLE HERE THAT IS NOT MEASURED ON 3.3.5a DATA and cannot be: it is a code constant
 * in the client, not a DBC. What the live data does confirm is that it is at least consistent with
 * 3.3.5a's art -- every region column the test roster's items fill is one this table marks reachable
 * for that slot, and none of them fills a `-1` cell. The visible consequence to check is trousers
 * under boots on the shared LegLower tile: pants stack at 0, boots at 2.
 */
const EQUIP_LAYER_PRIORITY: readonly (readonly number[])[] = [
  [0, 0, -1, 0, 0, -1, -1, -1], // shirt
  [1, 1, -1, 1, 1, 1, 1, -1], // chest (a robe reaches the legs)
  [-1, -1, -1, -1, -1, 2, -1, -1], // belt
  [-1, -1, -1, -1, -1, 0, 0, -1], // pants
  [-1, -1, -1, -1, -1, -1, 2, 0], // boots
  [-1, 2, -1, -1, -1, -1, -1, -1], // wrist
  [-1, 3, 0, -1, -1, -1, -1, -1], // gloves
  [-1, -1, -1, 3, 4, -1, -1, -1], // tabard
];

/**
 * The worn `ItemDisplayInfo` rows by bodyslot, plus the two slots that are not bodyslots.
 *
 * `null` per bodyslot means the slot is empty (or its display id has no row, which is a data problem
 * the caller warns about rather than a shape difference).
 */
export type WornEquipment = {
  bodyslots: (ItemDisplayInfoRow | null)[];
  cloak: ItemDisplayInfoRow | null;
  helm: ItemDisplayInfoRow | null;
};

/** True when nothing at all is worn -- the caller uses it to skip the 6.7 MB `ItemDisplayInfo` load. */
export function wearsNothing(equipment: EquipmentDisplay[] | undefined): boolean {
  if (!equipment?.length) {
    return true;
  }
  const slots = [...BODYSLOT_ENUM_SLOTS, ENUM_SLOT_HELM, ENUM_SLOT_CLOAK];
  return !slots.some((slot) => equipment[slot]?.displayId);
}

/** Project an `SMSG_CHAR_ENUM` equipment array onto the bodyslot order, through the display table. */
export function wornEquipmentFor(
  equipment: EquipmentDisplay[] | undefined,
  rowFor: (displayId: number) => ItemDisplayInfoRow | null,
): WornEquipment {
  const lookup = (slot: number): ItemDisplayInfoRow | null => {
    const displayId = equipment?.[slot]?.displayId ?? 0;
    return displayId ? rowFor(displayId) : null;
  };
  return {
    bodyslots: BODYSLOT_ENUM_SLOTS.map(lookup),
    cloak: lookup(ENUM_SLOT_CLOAK),
    helm: lookup(ENUM_SLOT_HELM),
  };
}

/**
 * The equipment half of the composite: the region layers, in blit order.
 *
 * PER LAYER, not per item -- and that is the whole point of the priority table. Two items can both
 * paint one tile (trousers and boots both reach LegLower; a shirt, a chest piece, a bracer and a
 * glove all reach ArmLower), and which one ends up on top is the table's answer, not the slot order's.
 * The reference's loop verbatim (`sections.rs:224-240`): gather every slot's contribution to the
 * layer, drop the `-1`s, sort ascending by priority, blit in that order.
 *
 * The sort must be STABLE for equal priorities. It is: `Array#sort` has been stable by spec since
 * ES2019. Two slots do share a priority in this table -- pants and boots both stack at 0 on Foot and
 * LegLower respectively, but never on the same layer, so no pair actually collides today.
 *
 * THE GENDER SUFFIX IS NOT DERIVABLE, so it is a candidate list rather than a path. The file is
 * `Item\TextureComponents\<dir>\<name>_<M|F|U>.blp` and nothing in `ItemDisplayInfo` says which
 * suffix an item authored -- the reference resolves it by trying the archive
 * (`read_equip_region`, `sections.rs:288-299`: gendered, then `_U`, then bare) and so does this,
 * through `BodyLayer.alternates`. Measured on the live host: `_U` is the majority and a gendered file
 * is real too, so neither order alone works; the gendered one must win where it exists, which is why
 * it is `path` and `_U` is the first alternate.
 */
export function equipLayersFor(worn: WornEquipment, gender: number): BodyLayer[] {
  const letter = gender === 1 ? 'F' : 'M';
  const layers: BodyLayer[] = [];

  for (let layer = 0; layer < EQUIP_TILE_NAMES.length; layer++) {
    const contributions: { priority: number; name: string }[] = [];
    worn.bodyslots.forEach((row, slot) => {
      const priority = EQUIP_LAYER_PRIORITY[slot][layer];
      const name = row?.[REGION_COLUMNS[layer]];
      if (priority >= 0 && typeof name === 'string' && name.length) {
        contributions.push({ priority, name });
      }
    });
    contributions.sort((a, b) => a.priority - b.priority);

    const tile = EQUIP_TILE_NAMES[layer];
    const dir = EQUIP_TEX_DIRS[layer];
    for (const { name } of contributions) {
      const stem = `Item\\TextureComponents\\${dir}\\${name}`;
      layers.push({
        tile,
        rect: COMPOSITE_TILES[tile],
        path: `${stem}_${letter}.blp`,
        alternates: [`${stem}_U.blp`, `${stem}.blp`],
      });
    }
  }

  return layers;
}
