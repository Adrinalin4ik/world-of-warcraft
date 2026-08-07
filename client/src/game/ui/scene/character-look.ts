/**
 * What to draw for one character: which `.m2`, at what scale, with which body skin, showing which
 * geosets.
 *
 * This is the DBC half of putting a character on the glue stage. Every number and column below was
 * read out of the live host (`https://data-direct.spelunkerdb.com/12340/dbfilesclient/...`) rather
 * than taken from a wiki, and the measurement is quoted where it decides something.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, so nobody reads a gap here as an oversight:
 *  - **No texture compositing.** The body skin goes into texture type 1 raw. The real client bakes an
 *    atlas of skin + face + facial hair + scalp + underwear + eight equipment regions into that slot;
 *    the base skin alone therefore leaves the atlas's face and pelvis tiles as the blank regions the
 *    file ships with. Known, and the compositor is its own piece of work.
 *  - **No hair and no facial hair.** The geosets are one `CharHairGeosets` /
 *    `CharacterFacialHairStyles` lookup away and `setVisibleGeosets` would show them today -- but
 *    `humanmale.m2`'s hair mesh reads texture type **6** (measured: its four texture defs are types
 *    1, 6, 0, 2), which nothing supplies yet, so the hair would draw with an unbound sampler. A bald
 *    head with real skin is an honest picture; a black helmet is not. Both wait for type 6.
 *  - **No equipment.** Needs `ItemDisplayInfo` (6.7 MB) and the eight geoset branches.
 */
import DBC from '../../pipeline/dbc';
import { CharacterRecord } from '../../../network/protocol/types';

/** Everything `GlueSceneView#setCharacter` needs, and nothing it does not. */
export type CharacterLook = {
  /** `CreatureModelData.file`, as the DBC spells it -- `M2Blueprint.load` rewrites `.mdx` itself. */
  modelPath: string;
  /** `CreatureDisplayInfo.scale`. Measured 1.0 for both Human display ids, 1.15 for Gnome male. */
  scale: number;
  /** `CharSections` BaseSection 0 `TextureName[0]`, or null if the table has no row for this look. */
  bodyTexture: string | null;
  /** The geoset ids to draw. See `NAKED_GEOSETS`. */
  geosets: Set<number>;
};

/**
 * The geosets a character with no hair, no beard and no equipment shows.
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
 * The list is benilla's base set (`characters/geosets.rs:51`), including its two outliers -- group 7
 * bases at **702** and not 701, and geoset **0** is unconditional. Ids in it that a given model does
 * not carry (`humanmale.m2` has no 601, 801, 901, 1001, 1101, 1201 or 1401; it has 802/803, 902/903,
 * 1002, 1102/1104, 1202 instead) simply match no submesh, which is the correct outcome: those groups
 * are pure equipment and a naked body shows none of them.
 */
export const NAKED_GEOSETS: readonly number[] = [
  0, 101, 201, 301, 401, 501, 601, 702, 801, 901, 1001, 1101, 1201, 1301, 1401, 1501,
];

/** `ChrRaces` gender column ids. `CharacterRecord.gender` uses the same 0/1. */
const MALE = 0;

/**
 * `CharSections.BaseSection` 0 -- the base body skin. The other four measured values are 1 face,
 * 2 facial hair, 3 hair, 4 underwear; only 0 is read here.
 */
const BASE_SECTION_SKIN = 0;

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

type ChrRacesRow = { id: number; maleDisplayID: number; femaleDisplayID: number };
type CharSectionsRow = {
  raceID: number;
  gender: number;
  generalType: number;
  textures: string[];
  flags: number;
  /** The schema's name for `ColorIndex` -- the dial value. See `bodySkinFor`. */
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
 * Resolve one character's look. Four DBC reads, all cached by `DBC.load`.
 *
 * `CreatureDisplayInfo` and `CreatureModelData` are already loaded at runtime by `classes/unit.ts`,
 * so the character path shares their cache rather than adding a fetch. `ChrRaces` (6 KB) and
 * `CharSections` (845 KB) are new loads. Measured chain for a Human Male:
 *
 *   ChrRaces id 1 -> maleDisplayID 49
 *   CreatureDisplayInfo 49 -> modelID 49, scale 1.0
 *   CreatureModelData 49 -> `Character\Human\Male\HumanMale.mdx`
 *   CharSections race 1 sex 0 base 0 colorIndex 0 -> `Character\Human\Male\HumanMaleSkin00_00.blp`
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

  return {
    modelPath: modelData.file,
    // `|| 1`, not `?? 1`: a zero scale is as unusable as a missing one, and the DBC's float column
    // reads 0 for a row that carries nothing.
    scale: displayInfo.scale || 1,
    bodyTexture,
    geosets: new Set(NAKED_GEOSETS),
  };
}
