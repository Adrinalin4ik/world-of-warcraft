/**
 * What to draw for one character: which `.m2`, at what scale, with which body skin, showing which
 * geosets.
 *
 * This is the DBC half of putting a character on the glue stage. Every number and column below was
 * read out of the live host (`https://data-direct.spelunkerdb.com/12340/dbfilesclient/...`) rather
 * than taken from a wiki, and the measurement is quoted where it decides something.
 *
 * TEXTURE TYPE 1 IS NOW A COMPOSITE, not the raw base skin. `bodyLayersFor` below builds the ordered
 * layer list -- base skin + face + facial hair + scalp + underwear -- and `body-composite.ts` blits it
 * into one 512x512 mipped texture. `bodyTexture` survives as the fallback for a bake that could not
 * happen. That closes three symptoms at once, all of which were the one absent bake: the scalp parting
 * showing bare skin, a skin-coloured beard (on `humanmale.m2` the facial-hair geosets read type 1, the
 * body atlas, so their art is a COMPOSITE layer and nothing else could colour them), and a male face
 * with no brow detail.
 *
 * EQUIPMENT IS NOW HERE, in `character-equipment.ts`: the eight `ItemDisplayInfo` region textures are
 * appended to `bodyLayersFor`'s list and the geoset branches are applied to the region-base slot
 * array. Both are reached from `resolveCharacterLook`, and both are skipped entirely -- including the
 * 6.7 MB `ItemDisplayInfo` fetch -- for a character wearing nothing.
 *
 * ATTACHMENTS ARE NOW HERE TOO, in `character-attachments.ts`: the weapons, the shield, the shoulder
 * pair and the helm's own model, as a list of `.m2` paths plus the body attachment id each hangs from.
 * `resolveCharacterLook` returns them and `glue-scene.ts` parents them to the body's bones. The
 * previous note here said a worn helm's hide-masks applied while the helmet did not draw; that is
 * fixed -- both halves are live.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, so nobody reads a gap here as an oversight:
 *  - **No `..._Extra` sheet (texture type 8).** `CharSections` BaseSection 0 `TextureName[1]`, bound
 *    whole rather than composited, and only fur races author it (Tauren head/leg fur). A Tauren
 *    therefore still draws part of its own body through an unbound sampler.
 */
import DBC from '../../pipeline/dbc';
import { CharacterAppearance, CharacterRecord } from '../../../network/protocol/types';
import { BodyLayer, COMPOSITE_TILES, compositeCacheKey } from './body-composite';
import { AttachedItem, attachedItemsFor } from './character-attachments';
import {
  HelmetGeosetVisDataRow,
  ItemDisplayInfoRow,
  REGION_BASES,
  WornEquipment,
  applyHelmetMasks,
  equipGeosetsFor,
  equipLayersFor,
  wearsNothing,
  wornEquipmentFor,
} from './character-equipment';

/** Everything `GlueSceneView#setCharacter` needs, and nothing it does not. */
export type CharacterLook = {
  /** `CreatureModelData.file`, as the DBC spells it -- `M2Blueprint.load` rewrites `.mdx` itself. */
  modelPath: string;
  /** `CreatureDisplayInfo.scale`. Measured 1.0 for both Human display ids, 1.15 for Gnome male. */
  scale: number;
  /**
   * `CharSections` BaseSection 0 `TextureName[0]`, or null if the table has no row for this look.
   *
   * This is the base skin RAW, and it is now the FALLBACK rather than the supply: texture type 1 gets
   * `bodyLayers` baked into one composite (`body-composite.ts`), and this path is bound only if the
   * bake could not happen at all -- a source that failed to fetch, or a compressed base skin.
   */
  bodyTexture: string | null;
  /**
   * The ordered layer list for the type-1 composite: base skin, face, facial hair, scalp, underwear.
   * See `bodyLayersFor` for the order's source and for how equipment appends to it.
   */
  bodyLayers: BodyLayer[];
  /**
   * The composite's cache key -- the whole appearance tuple, so re-selecting a roster row or cycling
   * a dial back is a map hit rather than eight fetches and a bake. Equipment extends this key when
   * piece 7 extends the layer list; the reference keys the same cache the same way
   * (`SkinKey { race, sex, skin, face, facial_hair, hair_style, hair_color, equip: [u32;8] }`).
   */
  compositeKey: string;
  /**
   * Texture type 6 -- `CharSections` BaseSection 3 `TextureName[0]`, keyed on the hairStyle and
   * hairColor dials. Null for a bald look, whose BaseSection 3 rows carry three EMPTY strings
   * (measured: Human Male VariationIndex 0, ids 3262..3271, all three texture columns blank).
   */
  hairTexture: string | null;
  /**
   * Texture type 2 -- the cloak sheet, `Item\ObjectComponents\Cape\<name>.blp` from the BACK slot's
   * `ItemDisplayInfo.leftModelTexture`. Null for a character with no cloak, which is every character
   * on the live test roster; the cloak GEOSET and this go together, so neither is set without the
   * other.
   */
  capeTexture: string | null;
  /** The geoset ids to draw. See `character-equipment.ts#REGION_BASES` for the bare-skin set. */
  geosets: Set<number>;
  /**
   * The separate `.m2` files that hang off the skeleton -- weapons, a shield, the shoulder pair, the
   * helm. Empty for a character carrying none, which is not the same as "no equipment": all five
   * roster characters are dressed and four of them hold something.
   *
   * See `character-attachments.ts` for the attachment ids, the placement law and the orientation
   * convention (there is none to choose: the bone supplies it).
   */
  attachments: AttachedItem[];
};

/** `ChrRaces` gender column ids. `CharacterRecord.gender` uses the same 0/1. */
const MALE = 0;

/**
 * `CharSections.BaseSection` 0 -- the base body skin. The other four measured values are 1 face,
 * 2 facial hair, 3 hair, 4 underwear; only 0 is read here.
 */
const BASE_SECTION_SKIN = 0;

/** `CharSections.BaseSection` 1 -- face. `TextureName[0]` lower head tile, `[1]` upper. */
const BASE_SECTION_FACE = 1;

/** `CharSections.BaseSection` 2 -- facial hair. Columns as for face; keyed on hairColor, not skin. */
const BASE_SECTION_FACIAL_HAIR = 2;

/** `CharSections.BaseSection` 3 -- hair. `TextureName[0]` is the type-6 mesh sheet. */
const BASE_SECTION_HAIR = 3;

/** `CharSections.BaseSection` 4 -- underwear. `TextureName[0]` into the pelvis tile. */
const BASE_SECTION_UNDERWEAR = 4;

/**
 * `CharSections.Flags` bits that disqualify a row from being a playable character-create look.
 *
 * Measured over the whole 8958-row table: the only values that occur are 1, 5, 6, 8, 17 and 18.
 * For Human Male BaseSection 0 the ten rows a player can pick carry flags **17** (`0x01 | 0x10`),
 * the two NPC-only rows (`HumanMaleSkin00_100/_101`) carry **8**, and the three Death Knight rows
 * (`HumanMaleSkin00_10/_11/_12`) carry **5** (`0x01 | 0x04`). So `0x04` is Death Knight and `0x08`
 * is NPC, and excluding both is what leaves exactly the ten dial positions the real client offers.
 * `0x10` is NOT tested: it is set on every one of those ten rows, so it cannot discriminate, and its
 * meaning is not settled by the data.
 */
const SECTION_FLAG_DEATH_KNIGHT = 0x04;
const SECTION_FLAG_NPC = 0x08;

type ChrRacesRow = {
  id: number;
  maleDisplayID: number;
  femaleDisplayID: number;
  /**
   * `ChrRaces` field 6. `Hu Or Dw Ni Sc Ta Gn Tr Go Be Dr` for races 1..11, read off the live table --
   * the prefix a helm's per-race-and-sex model file is named with. See
   * `character-attachments.ts#helmModelFile` for why this column and not a table of eight.
   */
  clientPrefix: string;
};
type CharHairGeosetsRow = { raceID: number; gender: number; hairType: number; geoset: number };
type CharacterFacialHairStylesRow = {
  raceID: number;
  gender: number;
  specificID: number;
  geosetIDs: number[];
};
export type CharSectionsRow = {
  raceID: number;
  gender: number;
  generalType: number;
  textures: string[];
  flags: number;
  /** The schema's name for `VariationIndex` -- the hairStyle dial on BaseSection 3 rows. */
  type: number;
  /** The schema's name for `ColorIndex` -- the skin or hairColor dial. See `bodySkinFor`. */
  variation: number;
};

/**
 * The display id for a race and gender.
 *
 * TWO SEPARATE COLUMNS, never one derived from the other. Measured: Blood Elf (race 10) is male
 * **15476** and female **15475** -- out of order -- so `female = male + 1` is wrong for a race that
 * ships in 3.3.5a. `ChrRaces` fields 4 and 5, which the existing schema already names correctly.
 */
export function displayIdFor(row: ChrRacesRow, gender: number): number {
  return gender === MALE ? row.maleDisplayID : row.femaleDisplayID;
}

/**
 * The body skin path for a race, gender and `CharacterAppearance.skin`.
 *
 * The dial indexes **ColorIndex** (`CharSections` field 9), not VariationIndex (field 8): measured
 * for Human Male BaseSection 0, all fifteen rows carry VariationIndex 0 while ColorIndex runs
 * 0..14, and the ten player rows are ColorIndex 0..9 -- so field 8 cannot address a skin and field 9
 * can. The repo's schema calls field 8 `type` and field 9 `variation`, which are the two names §2.2
 * of the research flags as wrong; the POSITIONS are right, so `variation` is read here and the names
 * are left alone rather than renamed in a milestone that is not about `CharSections`.
 *
 * Falls back to the lowest-ColorIndex eligible row when the requested dial has no row, so a
 * roster byte outside the table draws a real skin instead of nothing.
 */
export function bodySkinFor(
  rows: CharSectionsRow[],
  race: number,
  gender: number,
  skin: number,
): string | null {
  let fallback: CharSectionsRow | null = null;
  for (const row of rows) {
    if (!row || row.raceID !== race || row.gender !== gender) {
      continue;
    }
    if (row.generalType !== BASE_SECTION_SKIN) {
      continue;
    }
    if ((row.flags & (SECTION_FLAG_DEATH_KNIGHT | SECTION_FLAG_NPC)) !== 0) {
      continue;
    }
    if (row.variation === skin) {
      return row.textures?.[0] || null;
    }
    if (fallback === null || row.variation < fallback.variation) {
      fallback = row;
    }
  }
  return fallback?.textures?.[0] || null;
}

/**
 * The group-0 geoset a `hairStyle` dial shows.
 *
 * `CharHairGeosets` (measured: 339 records, 6 fields, 24-byte stride) keys on
 * (RaceID, SexID, VariationID) and its `geoset` column is TABLE DATA, not arithmetic -- measured for
 * Human Male, variation 1 maps to geoset **2**, 2 to 3, ... 16 to 17, and variation 0 maps to
 * geoset 0 with ShowScalp 1.
 *
 * `max(1, geoset)` is the reference's rule (`characters/geosets.rs`) and the measured data says why
 * it is needed: variation 0's geoset column is 0, and 0 is the BODY submesh group, already drawn
 * unconditionally. Geoset 1 is the bald scalp cap (`humanmale.m2` partID 1, 28 verts at z 1.88..2.02,
 * texture type 1), which is what a bald head must actually show.
 *
 * FIRST ROW WINS on a duplicate key, and duplicates are real: measured four rows for
 * (race 9 Goblin, sex 0, variation 0) with geosets 1, 2, 1, 2, and three for (race 8 Troll, sex 0,
 * variation 0). Answers null when the table describes no such (race, sex) at all, so the caller can
 * leave group 0 at the body alone rather than guess a scalp.
 */
export function hairGeosetFor(
  rows: CharHairGeosetsRow[],
  race: number,
  gender: number,
  hairStyle: number,
): number | null {
  let fallback: CharHairGeosetsRow | null = null;
  for (const row of rows) {
    if (!row || row.raceID !== race || row.gender !== gender) {
      continue;
    }
    if (row.hairType === hairStyle) {
      return Math.max(1, row.geoset);
    }
    // A roster byte the table does not describe falls to this race/sex's lowest variation rather
    // than to nothing -- the same shape `bodySkinFor` uses, and for the same reason.
    if (fallback === null || row.hairType < fallback.hairType) {
      fallback = row;
    }
  }
  return fallback === null ? null : Math.max(1, fallback.geoset);
}

/**
 * The hair sheet (texture type 6) for a hairStyle/hairColor pair.
 *
 * `CharSections` BaseSection 3: `VariationIndex` is the hairStyle dial and `ColorIndex` the hairColor
 * dial. Measured for Human Male hairStyle 11: ColorIndex 0..9 are the ten player rows (flags 17) and
 * carry `Character\Human\Hair02_00.blp` .. `Hair02_09.blp`, with ColorIndex 10..12 the Death Knight
 * rows (flags 5). Note the file stem is **Hair02**, not Hair11 -- the art family is table data too.
 * The ten colours are genuinely different art. Mean RGB of the decoded DXT colour blocks -- which
 * includes the sheet's transparent texels, so these are hue indicators and not rendered pixels:
 * `_00` (39,33,40) near-black, `_02` (101,56,52) auburn, `_05` (183,123,46) golden, `_09`
 * (131,126,125) grey. `_05` renders blonde on screen, which is the check that actually matters.
 *
 * Returns null for a bald look on purpose -- VariationIndex 0's three texture columns are empty
 * strings in the real table, and there is no hair mesh to sample them.
 */
export function hairTextureFor(
  rows: CharSectionsRow[],
  race: number,
  gender: number,
  hairStyle: number,
  hairColor: number,
): string | null {
  let fallback: CharSectionsRow | null = null;
  for (const row of rows) {
    if (!row || row.raceID !== race || row.gender !== gender) {
      continue;
    }
    if (row.generalType !== BASE_SECTION_HAIR || row.type !== hairStyle) {
      continue;
    }
    if ((row.flags & (SECTION_FLAG_DEATH_KNIGHT | SECTION_FLAG_NPC)) !== 0) {
      continue;
    }
    if (row.variation === hairColor) {
      return row.textures?.[0] || null;
    }
    if (fallback === null || row.variation < fallback.variation) {
      fallback = row;
    }
  }
  return fallback?.textures?.[0] || null;
}

/**
 * One `CharSections` texture column, by the full key. The general accessor the COMPOSITOR needs, next
 * to `bodySkinFor`/`hairTextureFor`, which are the two special cases that came first.
 *
 * The difference from those two is the missing-row behaviour, and it is deliberate rather than an
 * omission: this answers **null** when the key names no eligible row, because an overlay layer that
 * does not exist must be SKIPPED (the reference's own `continue`, `sections.rs:214`) -- a fallback to
 * some other colour's face tile would paint a visibly wrong face rather than the base skin's blank
 * one. `bodySkinFor` and `hairTextureFor` fall back on purpose: they supply whole texture slots,
 * where nothing means an untextured body or hair mesh.
 *
 * Same flag predicate as everywhere else here -- Death Knight and NPC rows excluded, `0x10` not
 * tested because it is set on every eligible row and so cannot discriminate.
 */
export function sectionTexture(
  rows: CharSectionsRow[],
  race: number,
  gender: number,
  baseSection: number,
  variationIndex: number,
  colorIndex: number,
  column: number,
): string | null {
  for (const row of rows) {
    if (!row || row.raceID !== race || row.gender !== gender) {
      continue;
    }
    if (row.generalType !== baseSection || row.type !== variationIndex) {
      continue;
    }
    if (row.variation !== colorIndex) {
      continue;
    }
    if ((row.flags & (SECTION_FLAG_DEATH_KNIGHT | SECTION_FLAG_NPC)) !== 0) {
      continue;
    }
    return row.textures?.[column] || null;
  }
  return null;
}

/**
 * Appearance -> the ordered layer list for the type-1 composite. The whole DBC side of the bake.
 *
 * THE ORDER IS THE REFERENCE'S, not an invention: `CharSections::composite_body`'s `overlays` array
 * (`benilla-formats/src/characters/sections.rs:205-212`) is base skin (already the canvas) -> face
 * lower -> face upper -> facial hair lower -> facial hair upper -> scalp lower -> scalp upper ->
 * underwear, and a later blit sits on top of an earlier one.
 *
 * THREE THINGS IN IT ARE TRAPS, all three from measured data rather than assumed:
 *  - **The texture COLUMN differs by section.** Face and facial hair use `TextureName[0]` for the
 *    lower head tile and `[1]` for the upper; HAIR uses `[1]` and `[2]`, because its `[0]` is the hair
 *    MESH sheet (texture type 6, sampled directly by the hair geoset) and must never enter the bake.
 *  - **The COLOR KEY differs by section.** Face and underwear key on `ColorIndex = skin`; facial hair
 *    and hair key on `ColorIndex = hairColor`. So a skin click is a FOUR-texture change -- base skin,
 *    face lower, face upper, underwear -- not one.
 *  - **The VARIATION key differs too.** Skin and underwear are variation 0; face is the face dial,
 *    facial hair the facialHair dial, hair the hairStyle dial.
 *
 * A missing row or an empty column is SKIPPED, matching the reference's `continue` (`sections.rs:214`)
 * -- and the empties are real: a bald look (hairStyle 0) carries three blank texture columns on its
 * BaseSection 3 row (measured, Human Male ids 3262..3271), so a bald character bakes 6 layers where a
 * haired one bakes 8. The base skin is the exception: without it there is no canvas, so the bake
 * answers null and the caller binds `bodyTexture` raw instead.
 *
 * For the real test character (Gesf: race 1, gender 0, skin 0, face 4, hairStyle 11, hairColor 5,
 * facialHair 1) this is the eight-layer list the measurement doc's §1 read out of the table by hand:
 *
 *   BODY        `HumanMaleSkin00_00.blp`             512x512  (0,0,512,512)
 *   HEAD_LOWER  `HumanMaleFaceLower04_00.blp`        256x128  (0,384,256,128)
 *   HEAD_UPPER  `HumanMaleFaceUpper04_00.blp`        256x64   (0,320,256,64)
 *   HEAD_LOWER  `FacialLowerHair01_05.blp`           128x64   (0,384,256,128)
 *   HEAD_UPPER  `FacialUpperHair01_05.blp`           128x32   (0,320,256,64)
 *   HEAD_LOWER  `ScalpLowerHair02_05.blp`            128x64   (0,384,256,128)
 *   HEAD_UPPER  `ScalpUpperHair02_05.blp`            128x32   (0,320,256,64)
 *   PELVIS      `HumanMaleNakedPelvisSkin00_00.blp`  256x128  (256,192,256,128)
 *
 * EQUIPMENT APPENDS TO THE RETURNED ARRAY and nothing else changes -- which is what the `worn`
 * argument does, through `equipLayersFor`. It goes last because every equipment tile sits on top of
 * the skin it covers, and one of them (LEG_UPPER) IS the pelvis tile, so trousers must blit after the
 * underwear rather than beside it. For Gesf, whose live gear is a shirt, trousers and boots, that is
 * six more layers: TorsoUpper/TorsoLower from the shirt, LegUpper/LegLower from the trousers, and
 * LegLower/Foot from the boots -- the shared LegLower tile taking the trousers first and the boots
 * over them, by the priority table.
 */
export function bodyLayersFor(
  rows: CharSectionsRow[],
  race: number,
  gender: number,
  appearance: CharacterAppearance | null | undefined,
  worn?: WornEquipment | null,
): BodyLayer[] {
  const skin = appearance?.skin ?? 0;
  const face = appearance?.face ?? 0;
  const facialHair = appearance?.facialHair ?? 0;
  const hairStyle = appearance?.hairStyle ?? 0;
  const hairColor = appearance?.hairColor ?? 0;

  const layers: BodyLayer[] = [];

  // The canvas. Through `bodySkinFor` and not a bare lookup, because a roster byte outside the table
  // must still draw a real body -- see its own comment for why that one falls back and this one's
  // overlays do not. The consequence, stated rather than hidden: if that fallback ever fires, the
  // face and underwear overlays are still keyed on the REQUESTED skin, find no row and are skipped,
  // so a corrupt skin byte draws a real body with a blank face rather than nothing at all.
  const base = bodySkinFor(rows, race, gender, skin);
  if (base) {
    layers.push({ tile: 'BODY', rect: COMPOSITE_TILES.BODY, path: base });
  }

  const overlays: [number, number, number, number, BodyLayer['tile']][] = [
    [BASE_SECTION_FACE, face, skin, 0, 'HEAD_LOWER'],
    [BASE_SECTION_FACE, face, skin, 1, 'HEAD_UPPER'],
    [BASE_SECTION_FACIAL_HAIR, facialHair, hairColor, 0, 'HEAD_LOWER'],
    [BASE_SECTION_FACIAL_HAIR, facialHair, hairColor, 1, 'HEAD_UPPER'],
    [BASE_SECTION_HAIR, hairStyle, hairColor, 1, 'HEAD_LOWER'],
    [BASE_SECTION_HAIR, hairStyle, hairColor, 2, 'HEAD_UPPER'],
    [BASE_SECTION_UNDERWEAR, 0, skin, 0, 'PELVIS'],
  ];

  for (const [section, variation, color, column, tile] of overlays) {
    const path = sectionTexture(rows, race, gender, section, variation, color, column);
    if (path) {
      layers.push({ tile, rect: COMPOSITE_TILES[tile], path });
    }
  }

  if (worn) {
    layers.push(...equipLayersFor(worn, gender));
  }

  return layers;
}

/**
 * The facial-hair geosets a `facialHair` dial shows, as `{ group: variant }` pairs already turned
 * into ids.
 *
 * `CharacterFacialHairStyles` (measured: 222 records, 8 fields, 32-byte stride, NO id column) keys on
 * (RaceID, SexID, VariationID) and carries five geoset VARIANT columns. Only the first three are ever
 * used by a playable race, and **the column -> geoset-group order was an open question the research
 * could not settle** because Human Male happens to carry only variants 1 and 2 in all three groups.
 *
 * IT IS SETTLED NOW, by four races whose columns and models disagree under any other assignment.
 * Method: read each column's distinct values per (race, sex) out of the DBC, then read which variants
 * each model's groups 1, 2 and 3 actually carry out of its `.skin`. Only one assignment keeps every
 * value in range:
 *
 *   Draenei Male   (11/0)  col1 = 1..8      model group 1 = 1..8      col3 = 2..6   group 2 = 2..6
 *   Tauren Female  (6/1)   col3 = 2..5      model group 2 = 2..5      (no group 1; group 3 = {2} only)
 *   Gnome Female   (7/1)   col3 = 2..7      model group 2 = 2..7      (no group 1, no group 3)
 *   Human Female   (1/1)   col2 = 2..7      model group 3 = 2..7      (no group 1, no group 2)
 *   Troll Male     (8/0)   col2 = 2..6      model group 3 = 2..6      (no group 1, no group 2)
 *
 * So **column 1 -> group 1, column 2 -> group 3, column 3 -> group 2**. That is also exactly what the
 * reference recorded for 1.12.1 (`characters/geosets.rs`: gA->1, gB->3, gC->2), so the ordering did
 * not change between builds -- but it is asserted here on 3.3.5a data, not inherited.
 *
 * Columns 4 and 5 are NOT mapped and this is honest ignorance, not a decision: column 4 is zero for
 * every one of the 222 rows except one garbage row (race 18 sex 1 carries 0xCCCCCCCC in both 4 and 5,
 * an uninitialized-memory artefact), and column 5 is a constant 2 for Blood Elf, Night Elf and
 * Undead. Blood Elf's models carry geosets 1702/1703 and no group 16, which makes group 17 the only
 * in-range reading for that 2 -- suggestive, not proven, and group 17 is the DK eye glow on Human. So
 * columns 4 and 5 are left alone.
 *
 * A zero column means "no geoset in that group", which the data bears out: Human Female's columns 1
 * and 3 are zero throughout and `humanfemale.m2` has no group 1 and no group 2 at all.
 */
export function facialGeosetsFor(
  rows: CharacterFacialHairStylesRow[],
  race: number,
  gender: number,
  facialHair: number,
): number[] | null {
  let fallback: CharacterFacialHairStylesRow | null = null;
  let match: CharacterFacialHairStylesRow | null = null;
  for (const row of rows) {
    if (!row || row.raceID !== race || row.gender !== gender) {
      continue;
    }
    if (row.specificID === facialHair) {
      match = row;
      break;
    }
    if (fallback === null || row.specificID < fallback.specificID) {
      fallback = row;
    }
  }
  const row = match ?? fallback;
  if (!row) {
    return null;
  }
  const [column1, column2, column3] = row.geosetIDs;
  const ids: number[] = [];
  if (column1) {
    ids.push(100 + column1);
  }
  if (column3) {
    ids.push(200 + column3);
  }
  if (column2) {
    ids.push(300 + column2);
  }
  return ids;
}

/**
 * Resolve one character's look. Six DBC reads, all cached by `DBC.load`.
 *
 * All six go through `DBC.load`, whose cache is a static keyed by table name -- so `classes/unit.ts`
 * asking for `CreatureDisplayInfo`/`CreatureModelData` in the world hits whatever this warmed, and
 * vice versa. On a glue screen nothing has warmed them, so these are cold fetches, measured over the
 * wire: `CreatureDisplayInfo` 1.6 MB, `CreatureModelData` 197 KB, `CharSections` 845 KB, `ChrRaces`
 * 6 KB, and the two this round adds -- `CharHairGeosets` 8.2 KB and `CharacterFacialHairStyles`
 * 7.1 KB. Together 15 KB against the 2.6 MB already in flight, i.e. hair costs ~0.6% more bytes and
 * two more round trips.
 *
 * Measured chain for the real test character (Gesf: race 1, gender 0, skin 0, face 4, hairStyle 11,
 * hairColor 5, facialHair 1 -- read off the live server, not assumed):
 *
 *   ChrRaces id 1 -> maleDisplayID 49
 *   CreatureDisplayInfo 49 -> modelID 49, scale 1.0
 *   CreatureModelData 49 -> `Character\Human\Male\HumanMale.mdx`
 *   CharSections race 1 sex 0 base 0 colorIndex 0 -> `Character\Human\Male\HumanMaleSkin00_00.blp`
 *   CharHairGeosets race 1 sex 0 variation 11 -> geoset 12
 *   CharSections race 1 sex 0 base 3 var 11 color 5 -> `Character\Human\Hair02_05.blp` (blonde)
 *   CharacterFacialHairStyles race 1 sex 0 variation 1 -> columns (1, 2, 1) -> geosets 101, 302, 201
 *
 * Answers null rather than throwing when a row is missing, and says which link broke: a character
 * whose race the client's own DBCs do not describe is a data problem to read on the console, not an
 * exception through the glue frame loop.
 */
export async function resolveCharacterLook(
  character: CharacterRecord,
): Promise<CharacterLook | null> {
  const raceRow: ChrRacesRow | undefined = await DBC.load('ChrRaces', character.race);
  if (!raceRow) {
    console.warn(`glue character: ChrRaces has no row for race ${character.race}`);
    return null;
  }

  const displayId = displayIdFor(raceRow, character.gender);
  const displayInfo = await DBC.load('CreatureDisplayInfo', displayId);
  if (!displayInfo) {
    console.warn(`glue character: CreatureDisplayInfo has no row ${displayId}`);
    return null;
  }

  const modelData = await DBC.load('CreatureModelData', displayInfo.modelID);
  if (!modelData?.file) {
    console.warn(`glue character: CreatureModelData has no file for ${displayInfo.modelID}`);
    return null;
  }

  const sections = await DBC.load('CharSections');
  const bodyTexture = bodySkinFor(
    (sections?.records ?? []) as CharSectionsRow[],
    character.race,
    character.gender,
    character.appearance?.skin ?? 0,
  );
  if (bodyTexture === null) {
    console.warn(
      `glue character: CharSections has no BaseSection 0 row for race ${character.race} ` +
        `gender ${character.gender} -- the body draws untextured`,
    );
  }

  const appearance = character.appearance;
  const sectionRows = (sections?.records ?? []) as CharSectionsRow[];
  // The 16 region-base SLOTS, not a set: the customization overwrites slots 0..3, a worn helm's masks
  // force some of those back, and only then do the equipment branches add and disable. That is the
  // client's order and the reference's (`geosets.rs:57-141`), and it is the reason this is an indexed
  // array here where it used to be a `Set` -- a set cannot express "slot 2 currently holds 201".
  const slots = [...REGION_BASES];

  // Slot 0: the hairstyle. Geoset 0 (the body) is not a slot -- `equipGeosetsFor` adds it
  // unconditionally at the end.
  const hairRows = ((await DBC.load('CharHairGeosets'))?.records ?? []) as CharHairGeosetsRow[];
  const hairGeoset = hairGeosetFor(
    hairRows,
    character.race,
    character.gender,
    appearance?.hairStyle ?? 0,
  );
  if (hairGeoset !== null) {
    slots[0] = hairGeoset;
  }
  const hairTexture = hairTextureFor(
    sectionRows,
    character.race,
    character.gender,
    appearance?.hairStyle ?? 0,
    appearance?.hairColor ?? 0,
  );

  // Slots 1, 2 and 3 are the facial-hair groups and the dial owns ALL THREE of them: a variation that
  // leaves a column at zero means that group draws nothing, which as a SLOT write is just the base
  // staying put -- the awkward "delete 101/201/301 first" this used to do was the set representation
  // showing through. `facialGeosetsFor` still answers null for a (race, sex) the table does not
  // describe at all, in which case the three bases stand.
  const facialRows = ((await DBC.load('CharacterFacialHairStyles'))?.records ??
    []) as CharacterFacialHairStylesRow[];
  const facialGeosets = facialGeosetsFor(
    facialRows,
    character.race,
    character.gender,
    appearance?.facialHair ?? 0,
  );
  if (facialGeosets !== null) {
    // The id already carries its group: 101.. is slot 1, 201.. slot 2, 301.. slot 3. A column left at
    // zero produced no id at all, so its base is untouched.
    for (const id of facialGeosets) {
      slots[Math.floor(id / 100)] = id;
    }
  }

  const worn = await resolveWornEquipment(character);
  if (worn) {
    const helmetRows = worn.helm
      ? (((await DBC.load('HelmetGeosetVisData'))?.records ?? []) as HelmetGeosetVisDataRow[])
      : [];
    applyHelmetMasks(slots, worn, helmetRows, character.race, character.gender);
  }

  return {
    modelPath: modelData.file,
    bodyLayers: bodyLayersFor(sectionRows, character.race, character.gender, appearance, worn),
    compositeKey: compositeCacheKey(character.race, character.gender, appearance, character.equipment),
    // `|| 1`, not `?? 1`: a zero scale is as unusable as a missing one, and the DBC's float column
    // reads 0 for a row that carries nothing.
    scale: displayInfo.scale || 1,
    bodyTexture,
    hairTexture,
    capeTexture: capeTextureFor(worn),
    geosets: worn ? equipGeosetsFor(slots, worn) : new Set([0, ...slots]),
    // Piece 9. `raceRow.clientPrefix` is only read by a HELM (the one per-race-and-sex file name);
    // weapons, shields and pauldrons are one file for every race.
    attachments: worn ? attachedItemsFor(worn, raceRow.clientPrefix ?? '', character.gender) : [],
  };
}

/**
 * The cloak sheet for texture type 2, or null.
 *
 * `leftModelTexture` and NOT a region column: a cloak paints no body region at all -- its own
 * `ItemDisplayInfo` row leaves all eight region columns empty (measured: row 13963
 * `Cape_Mage_A_01Black` has `geosetGroupIDs [1,0,0]`, an empty `leftModelFile`, and one texture name)
 * -- so it is a geoset plus a whole-sheet bind, which is exactly what texture type 2 is for.
 *
 * The directory is `Item\ObjectComponents\Cape`, the same `ObjectComponents` tree the weapon and
 * shoulder models live under, verified fetchable on the live host.
 */
function capeTextureFor(worn: WornEquipment | null): string | null {
  const name = worn?.cloak?.leftModelTexture;
  return name ? `Item\\ObjectComponents\\Cape\\${name}.blp` : null;
}

/**
 * The worn `ItemDisplayInfo` rows for a character, or null when nothing is worn.
 *
 * NULL IS THE POINT. `ItemDisplayInfo` is **6.7 MB over the wire** -- measured, and by a wide margin
 * the largest table on this screen's critical path (`CharSections` is 845 KB, everything else under
 * 200 KB). A character wearing nothing needs none of it, and neither does a test: skipping the load
 * for an empty equipment array is what keeps the naked path exactly as cheap as it was before piece 7,
 * and it is why `character-look.test.ts` still runs against four tables.
 *
 * The table is loaded ONCE per session and shared -- `DBC.load`'s cache is a static keyed by table
 * name -- so the cost is paid by whichever roster row is selected first and by no other.
 */
async function resolveWornEquipment(character: CharacterRecord): Promise<WornEquipment | null> {
  if (wearsNothing(character.equipment)) {
    return null;
  }
  const table = await DBC.load('ItemDisplayInfo');
  if (!table) {
    console.warn('glue character: ItemDisplayInfo did not load -- the character draws undressed');
    return null;
  }
  return wornEquipmentFor(character.equipment, (displayId) => {
    // `DBC` indexes its records by id onto itself (`pipeline/dbc/index.js#index`), so this is a
    // property read and not a scan -- which matters at 57 986 rows and eleven lookups per character.
    const row = (table as unknown as Record<number, ItemDisplayInfoRow | undefined>)[displayId];
    if (!row) {
      console.warn(`glue character: ItemDisplayInfo has no row ${displayId}`);
      return null;
    }
    return row;
  });
}
