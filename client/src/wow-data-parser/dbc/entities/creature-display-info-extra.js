import * as r from 'restructure';

import Entity from '../entity';
import StringRef from '../string-ref';

/**
 * `CreatureDisplayInfoExtra.dbc` -- what a HUMANOID npc looks like.
 *
 * A `CreatureDisplayInfo` row is one of two kinds and this table is what separates them. 15 451 of the
 * live table's 24 262 rows carry a non-zero `extraInfoID` and reach here; the other 8 811 are ordinary
 * creatures whose skin comes from the row's own texture-variation columns. Measured on the live host:
 * 15 475 records, **21 fields**, 84-byte stride.
 *
 * THREE FIELD NAMES WERE WRONG HERE and are corrected below. The positions were always right -- the
 * reader hard-seeks by the header's `recordSize` -- but `hairType`/`hairStyle`/`beardStyle` named
 * fields 5/6/7, which are really hairStyle, hairColor and facialHair. Settled by measuring each
 * column's value range per (race, sex) against the tables that consume them, which agree exactly and
 * could not under any other assignment:
 *
 *   field 5, Human male 0..16  <->  `CharHairGeosets` variations for (1, 0) are 0..16
 *   field 5, Human female 0..23 <-> `CharHairGeosets` variations for (1, 1) are 0..23
 *   field 6, Human male 0..12  <->  `CharSections` BaseSection 3 ColorIndex for (1, 0) is 0..12
 *   field 7, Human male 0..8   <->  `CharacterFacialHairStyles` variations for (1, 0) are 0..8
 *   field 3, Human male 0..14  <->  `CharSections` BaseSection 0 ColorIndex for (1, 0) is 0..14
 *
 * The eleven item columns are **`ItemDisplayInfo` row ids**, not item entries: all 92 091 non-zero
 * references in the live table resolve against `ItemDisplayInfo`'s 57 986 rows, and the region-texture
 * columns of the referenced rows match their slot (the shirt id's row fills Sleeve/Chest, the boots
 * id's fills Boot_LL/Boot_FO). See `ui/scene/npc-look.ts`.
 */
export default Entity({
  id: r.uint32le,
  raceID: r.uint32le,
  gender: r.uint32le,

  /** `CharSections` BaseSection 0 ColorIndex -- the same dial `CharacterAppearance.skin` is. */
  skinColor: r.uint32le,
  /** `CharSections` BaseSection 1 VariationIndex. */
  faceType: r.uint32le,
  /** `CharHairGeosets` VariationID **and** `CharSections` BaseSection 3 VariationIndex. */
  hairStyle: r.uint32le,
  /** `CharSections` BaseSection 3 ColorIndex. Was named `hairStyle`; see the note above. */
  hairColor: r.uint32le,
  /** `CharacterFacialHairStyles` VariationID. Was named `beardStyle`. */
  facialHair: r.uint32le,

  // Fields 8..18, `NPCItemDisplay[11]`, in the client's own slot order. Each is an `ItemDisplayInfo`
  // row id or 0 for an empty slot.
  helmID: r.uint32le,
  shoulderID: r.uint32le,
  shirtID: r.uint32le,
  cuirassID: r.uint32le,
  beltID: r.uint32le,
  legsID: r.uint32le,
  bootsID: r.uint32le,
  wristID: r.uint32le,
  glovesID: r.uint32le,
  tabardID: r.uint32le,
  capeID: r.uint32le,

  /**
   * Field 19. Was declared `canEquip: r.Boolean`, which is a reading nothing in this repo ever used
   * and which the data does not support -- it is the row's flag word. Left unnamed beyond `flags`
   * because no consumer needs it and guessing a bit would be worse than saying so.
   */
  flags: r.uint32le,

  /**
   * Field 20, `BakeName` -- the PRE-BAKED body atlas for this npc, served from
   * `Textures\BakedNpcTextures\<name>`.
   *
   * THIS IS WHY A HUMANOID NPC NEEDS NO COMPOSITOR. The value is either a 32-hex-digit name or
   * `CreatureDisplayExtra-NNNNN.blp`; measured on the live host, a 41-name stratified sample across
   * both families answered 200 for every one, at 256x256 DXT (BLP2 `colorEncoding = 2`), which
   * `pipeline/blp/loader.js` uploads compressed with no decode at all. 22 of the 15 475 rows carry an
   * empty name; `npc-look.ts` falls back to the raw base skin for those and says so.
   */
  texture: StringRef
});
