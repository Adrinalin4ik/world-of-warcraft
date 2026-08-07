/**
 * What the character is WEARING: the eight `ItemDisplayInfo` region textures that composite into the
 * body atlas (piece 7), and the geoset branches and helm hide-masks that change the mesh (piece 8).
 *
 * The whole file is a port of the reference's two functions --
 * `CharSections::composite_body`'s equipment half (`benilla-formats/src/characters/sections.rs:222-240`,
 * tables at `:36-76`) and `CharacterGeosets::visible_geosets` (`characters/geosets.rs:51-150`) -- with
 * the tile numbers doubled for the 512 canvas and every DBC claim re-read on 3.3.5a data rather than
 * inherited. Where 3.3.5a disagrees with the reference it is said so at the point of disagreement.
 *
 * WHY IT IS A SEPARATE FILE FROM `character-look.ts`. That file is the appearance dials -- five bytes
 * from `SMSG_CHAR_ENUM` against `CharSections`. This one is the worn items -- 23 equipment slots
 * against `ItemDisplayInfo`, a 6.7 MB table with an entirely different shape. They meet in exactly two
 * places, both in `character-look.ts`: the layer list gets these layers appended, and the geoset slot
 * array gets these branches applied.
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
  /**
   * Fields 1/2. The sub-model FILE names (no directory), `.mdx` as the DBC spells them. Empty on the
   * overwhelming majority of rows: only weapons, shields, shoulders and helms carry one. See
   * `character-attachments.ts` for which column is which and which directory each kind lives in.
   */
  leftModelFile: string;
  rightModelFile: string;
  /**
   * Fields 3/4. The sub-model's own texture NAME (no directory, no extension) -- for the BACK slot
   * `leftModelTexture` is the cloak sheet texture type 2 wants; for a shoulder, weapon, shield or helm
   * row it is that MODEL's own type-2 skin (`character-attachments.ts`). `rightModelTexture` is only
   * ever the right pauldron's.
   */
  leftModelTexture: string;
  rightModelTexture: string;
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
 * The ORDER is the client's bodyslot 2..9 order, which is what indexes `EQUIP_LAYER_PRIORITY`'s rows
 * and the geoset branches: shirt, chest, belt, pants, boots, wrist, gloves, tabard.
 */
export const BODYSLOT_ENUM_SLOTS = [3, 4, 5, 6, 7, 8, 9, 18] as const;

/** Bodyslot indices, named, because the geoset branches below read them by hand. */
const SLOT_SHIRT = 0;
const SLOT_CHEST = 1;
const SLOT_PANTS = 3;
const SLOT_BOOTS = 4;
const SLOT_GLOVES = 6;
const SLOT_TABARD = 7;

/**
 * The `SMSG_CHAR_ENUM` slots that are not bodyslots but still change what is drawn.
 *
 * `ENUM_SLOT_SHOULDER` and `ENUM_HELD_SLOTS` are consumed by `character-attachments.ts` and declared
 * HERE rather than there, so that the two files' dependency runs one way only: attachments reads this
 * file's types and constants, and this file imports nothing from it. A value cycle between them would
 * be a live hazard, not a style point -- `wearsNothing` below needs the slot numbers at module scope.
 */
export const ENUM_SLOT_HELM = 0;
export const ENUM_SLOT_CLOAK = 14;
export const ENUM_SLOT_SHOULDER = 2;
/** Mainhand, offhand, ranged -- `EQUIPMENT_SLOT_MAINHAND/OFFHAND/RANGED`, and `placement`'s order. */
export const ENUM_HELD_SLOTS = [15, 16, 17] as const;

/**
 * The client's `[0x803bf8]` bodyslot x layer stacking table, transcribed from the reference
 * (`sections.rs:66-76`), which reverse-engineered it out of the binary. Rows are the eight bodyslots
 * above, columns the eight layers; the value is the order a slot's contribution stacks at WITHIN the
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
  /**
   * The SHOULDER slot (enum slot 2). Not a bodyslot and never was -- a pauldron paints no body region
   * at all (`ItemDisplayInfo` 1057's eight region columns are empty) -- it is purely two attached
   * models, so it sits here beside the helm rather than in `bodyslots`.
   */
  shoulder: ItemDisplayInfoRow | null;
  /**
   * Mainhand, offhand and ranged, in that order -- `placement`'s held-slot index
   * (`character-attachments.ts`). The `inventoryType` rides along because it is what `placement`
   * branches on and it is NOT in `ItemDisplayInfo`: it comes off the wire per equipment slot
   * (`world-wire.ts:138-142`), so it has to be carried from the enum record rather than looked up.
   */
  held: ({ row: ItemDisplayInfoRow; inventoryType: number } | null)[];
};

/**
 * True when nothing at all is worn -- the caller uses it to skip the 6.7 MB `ItemDisplayInfo` load.
 *
 * The slot list has to cover every slot ANY consumer reads, and it grew twice: the shoulder slot and
 * the held triple were absent while nothing consumed them, so a character wearing only a weapon (or
 * only pauldrons) would have short-circuited here and drawn empty-handed for want of the table. No
 * roster character is in that state -- all five wear a shirt -- which is exactly why it would have been
 * an invisible bug rather than a visible one.
 */
export function wearsNothing(equipment: EquipmentDisplay[] | undefined): boolean {
  if (!equipment?.length) {
    return true;
  }
  const slots = [
    ...BODYSLOT_ENUM_SLOTS,
    ENUM_SLOT_HELM,
    ENUM_SLOT_CLOAK,
    ENUM_SLOT_SHOULDER,
    ...ENUM_HELD_SLOTS,
  ];
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
    shoulder: lookup(ENUM_SLOT_SHOULDER),
    held: ENUM_HELD_SLOTS.map((slot) => {
      const row = lookup(slot);
      // `?? 0` and not a fallback guess: `placement` treats an unknown inventory type as a plain
      // weapon, which is the right default for slot 15/16 and irrelevant for 17 (nothing is drawn
      // there at all on this screen), so a missing byte degrades to "held in the hand" rather than to
      // nothing.
      return row ? { row, inventoryType: equipment?.[slot]?.inventoryType ?? 0 } : null;
    }),
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

/**
 * The 16 region-base geosets a character with no hair, no beard and no equipment shows, in the
 * client's own SLOT order (`geosets.rs:16-18`, `cc+0x144`).
 *
 * An ordered slot array and not a set, because both the helm hide-masks and the equipment branches
 * address a slot by INDEX: slots 0..3 are the customization's (hair, then the three facial-hair
 * groups) and are overwritten by it, then a helm forces some of those back, and only then do the
 * branches add and disable. Slots 4..15 are the equipment groups' bare-skin defaults and the branches
 * add BESIDE them rather than replacing them, except where one explicitly disables a range.
 *
 * `geosetId = group * 100 + variant`, confirmed on `humanmale00.skin` (54 distinct `partID`s, every
 * one of them of that shape). Variant 1 is each group's "wearing nothing" mesh, which is real
 * geometry and not an empty slot -- it is the seam filler the group's other variants replace.
 * Measured bounding boxes on that file, model space, for the ids in this list that the file has:
 *
 *   partID 0    563 verts  z 0.00..1.96   the whole body, bald head included
 *   partID 0      8 verts  z 1.88..1.89   the scalp cap (a SECOND submesh with the same id)
 *   partID 101   12 verts  z 1.76..1.81   chin, clean
 *   partID 201    8 verts  z 1.80..1.90   moustache region, clean
 *   partID 301   13 verts  z 1.81..1.84   sideburn region, clean
 *   partID 401   70 verts  z 1.00..1.32   bare hand
 *   partID 501   62 verts  z 0.13..0.61   bare foot
 *   partID 702   14 verts  z 1.84..1.91   ear
 *   partID 1301  91 verts  z 0.55..1.11   hip/thigh, the mesh a robe replaces
 *   partID 1501  23 verts  z 1.58..1.81   collar, the mesh a cloak replaces
 *
 * TWO OUTLIERS, both benilla's and both real. Group 7's base is **702**, not 701 -- `humanmale00.skin`
 * carries both, and 701 is the tucked-under-a-helm ear the helm masks force. And **geoset 0**, the
 * body itself, is not a slot at all: it is unconditional, added by `equipGeosetsFor`, exactly as the
 * reference does it (`geosets.rs:59`).
 *
 * Ids in here that a given model does not carry (`humanmale.m2` has no 601, 801, 901, 1001, 1101,
 * 1201 or 1401; it has 802/803, 902/903, 1002, 1102/1104, 1202 instead) simply match no submesh,
 * which is the correct outcome: those groups are pure equipment and a naked body shows none of them.
 *
 * Slot 0's base being **1** (the bald scalp cap) is the one behavioural difference from the flat
 * `NAKED_GEOSETS` list this replaced, which carried 0 there and leaned on `hairGeosetFor`'s
 * `max(1, ...)` to supply the cap. Identical for every (race, sex) `CharHairGeosets` describes; for
 * one it does not, the cap is now shown instead of nothing.
 */
export const REGION_BASES: readonly number[] = [
  1, 101, 201, 301, 401, 501, 601, 702, 801, 901, 1001, 1101, 1201, 1301, 1401, 1501,
];

/**
 * A worn helm's `HelmetGeosetVisData` masks: which region-base slots it forces back to a base, so the
 * styled hair, the beard and the ears tuck under the helmet instead of poking through it.
 *
 * MEASURED on 3.3.5a: 21 records, 8 fields, 32-byte stride -- an id plus **seven** mask columns, and
 * each mask is a race bitfield (`1 << raceID`). The reference reads five (`geosets.rs:29-31`, verified
 * against the client's `0x4799a0`) and forces slots {0, 1, 2, 3, 7} to {1, 101, 201, 301, 701}. That
 * is what is implemented here.
 *
 * COLUMNS 6 AND 7 ARE NOT IMPLEMENTED, AND THIS IS UNEXPLAINED, not a decision. The research
 * (`2026-08-07-character-model-findings.md` §2.4) says "5 used, 2 always zero"; **that is wrong** --
 * measured, four of the 21 rows carry a non-zero column 6 or 7:
 *
 *   285  4094 4094 4094 4094 4094 | 256        0
 *   370     0    0    0    0    0 |   0  0xffffffff
 *   371     0    0    0    0    0 | 0xffffffff  0
 *   376  4194238 0  128   4  4194302 | 1024     0
 *
 * Row 285 is referenced by 67 display rows and 376 by 9, so this is live data and not padding. Which
 * region-base slots those two columns address is not settled by anything measured here and no
 * reference covers it (benilla is 1.12.1, whose table has five columns), so guessing would silently
 * hide or show a geoset on some helms. Consequence, stated rather than hidden: on the handful of
 * helms whose rows use column 6 or 7, one geoset group that the real client tucks away will stay
 * visible. Settled by: a 3.3.5a client screenshot of a helm using row 285 or 376 on a race whose bit
 * is set, against ours.
 */
const HELM_FORCED_SLOTS: readonly { column: number; slot: number; forced: number }[] = [
  { column: 0, slot: 0, forced: 1 }, // hair -> the bare scalp
  { column: 1, slot: 1, forced: 101 }, // facial group 1 -> clean
  { column: 2, slot: 2, forced: 201 }, // facial group 2 -> clean
  { column: 3, slot: 3, forced: 301 }, // facial group 3 -> clean
  { column: 4, slot: 7, forced: 701 }, // ears -> 701, the tucked-under ear, over the 702 default
];

export type HelmetGeosetVisDataRow = { id: number; hideGeosets: number[] };

/**
 * Apply a worn helm's hide-masks to the region-base slot array, in place.
 *
 * Runs AFTER the customization has written slots 0..3 and BEFORE the equipment branches, which is the
 * client's order and matters: the mask's job is to undo the hairstyle the dials just chose, and the
 * slots it touches ({0,1,2,3,7}) are disjoint from every branch's, so nothing downstream re-reveals
 * what it hid.
 */
export function applyHelmetMasks(
  slots: number[],
  worn: WornEquipment,
  rows: HelmetGeosetVisDataRow[],
  race: number,
  gender: number,
): void {
  const rowId =
    gender === 1 ? worn.helm?.femaleHelmetGeosetVisID : worn.helm?.maleHelmetGeosetVisID;
  if (!rowId) {
    return;
  }
  const row = rows.find((candidate) => candidate?.id === rowId);
  if (!row) {
    console.warn(`glue character: HelmetGeosetVisData has no row ${rowId}`);
    return;
  }
  // `race & 0x1f` is the reference's own guard (`geosets.rs:84`): the mask is 32 bits and `ChrRaces`
  // tops out at 21, so this cannot fire on shipped data -- it keeps a corrupt race byte from
  // shifting out of range rather than being a real modulus.
  const bit = 1 << (race & 0x1f);
  for (const { column, slot, forced } of HELM_FORCED_SLOTS) {
    if ((row.hideGeosets?.[column] ?? 0) & bit) {
      slots[slot] = forced;
    }
  }
}

/**
 * The equipment geoset branches: the region-base slots plus what the worn items add and take away.
 *
 * The reference's B1..B8 verbatim (`geosets.rs:88-141`), which took them from the client's RF-0038
 * arithmetic rather than from its prose. Read as a whole they say: a garment either REPLACES the mesh
 * of its own group (gloves, boots, cloak, robe -- disable the range, add `base + variant`) or ADDS a
 * mesh beside the bare-skin default (sleeves, kneepads, doublet, tabard flap, pant legs).
 *
 * Four things in it are traps, all four the reference's own notes and all four kept:
 *  - **The pant-leg base is 1102, not 1101.** `humanmale00.skin` carries 1102 and 1104 in group 11 and
 *    no 1101 at all, which is the confirmation on 3.3.5a data.
 *  - **A robe is `geosetGroupIDs[2]` on the CHEST or the PANTS slot**, either one, and it suppresses
 *    the tabard and the pant legs as well as showing its own skirt.
 *  - **Boots deliberately leave the naked 501 on** rather than disabling group 5, unlike gloves. That
 *    asymmetry is the client's, recorded as such.
 *  - **A shirt's sleeves only show with no chest item over them**, but its doublet always does.
 *
 * MEASURED on 3.3.5a, and it changes what can be verified rather than what the code does: only
 * **11 763 of 57 986** `ItemDisplayInfo` rows carry any non-zero `geosetGroupIDs`, and every item the
 * live test roster wears carries `[0, 0, 0]`. So the branches are correct-by-port and exercised by
 * staged rows, not by the test character -- see the report.
 */
export function equipGeosetsFor(slots: number[], worn: WornEquipment): Set<number> {
  const geosets = new Set<number>(slots);
  // Geoset 0, the body, unconditionally (`geosets.rs:59`).
  geosets.add(0);

  /** A bodyslot's `geosetGroupIDs[sub]`, or null when the slot is empty or the selector is zero. */
  const g = (slot: number, sub: number): number | null => {
    const value = worn.bodyslots[slot]?.geosetGroupIDs?.[sub] ?? 0;
    return value || null;
  };
  const disable = (lo: number, hi: number): void => {
    for (const id of [...geosets]) {
      if (id >= lo && id <= hi) {
        geosets.delete(id);
      }
    }
  };

  const robe = g(SLOT_CHEST, 2) ?? g(SLOT_PANTS, 2);

  // B1: gloves replace the glove group; otherwise the chest piece's sleeves.
  const gloves = g(SLOT_GLOVES, 0);
  if (gloves !== null) {
    disable(401, 499);
    geosets.add(401 + gloves);
  } else {
    const sleeves = g(SLOT_CHEST, 0);
    if (sleeves !== null) {
      geosets.add(801 + sleeves);
    }
  }

  // B3: the shirt's sleeves, only with no chest item over them.
  if (!worn.bodyslots[SLOT_CHEST]) {
    const shirtSleeves = g(SLOT_SHIRT, 0);
    if (shirtSleeves !== null) {
      geosets.add(801 + shirtSleeves);
    }
  }

  // B4: a robe hides boots, kneepads, pant legs and trousers and shows its own skirt; otherwise boots
  // add their boot mesh over the naked 501; otherwise the trousers' kneepads.
  const boots = g(SLOT_BOOTS, 0);
  const kneepads = g(SLOT_PANTS, 1);
  if (robe !== null) {
    disable(501, 599);
    disable(902, 999);
    disable(1100, 1199);
    disable(1300, 1399);
    geosets.add(1301 + robe);
  } else if (boots !== null) {
    geosets.add(501 + boots);
  } else if (kneepads !== null) {
    geosets.add(901 + kneepads);
  }

  // B5: the tabard flap. A robe hides it.
  if (robe === null) {
    const tabard = g(SLOT_TABARD, 0);
    if (tabard !== null) {
      geosets.add(1201 + tabard);
    }
  }

  // B7: the shirt's doublet, and the trousers' leg geoset off the 1102 base.
  const doublet = g(SLOT_SHIRT, 1);
  if (doublet !== null) {
    geosets.add(1001 + doublet);
  }
  if (robe === null) {
    const legs = g(SLOT_PANTS, 0);
    if (legs !== null) {
      geosets.add(1102 + legs);
    }
  }

  // B8: a cloak replaces the cloak group. `geosetGroupIDs[0]` of the BACK slot's row -- the cloak is
  // not a bodyslot (it paints no body region, only a geoset and a type-2 texture), which is why it
  // reaches this function through `WornEquipment.cloak` rather than through `bodyslots`.
  const cloak = worn.cloak?.geosetGroupIDs?.[0] || null;
  if (cloak !== null) {
    disable(1500, 1599);
    geosets.add(1501 + cloak);
  }

  return geosets;
}
