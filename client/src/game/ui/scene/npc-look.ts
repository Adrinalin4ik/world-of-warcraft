/**
 * What to draw for a HUMANOID NPC -- a guard, a villager, an innkeeper.
 *
 * THE SPLIT THIS FILE EXISTS FOR, and it is measured rather than assumed. A `CreatureDisplayInfo` row
 * is one of two kinds, and the live 3.3.5a table divides cleanly:
 *
 *   8 811 of 24 262 rows have `extraInfoID = 0`. Their skin is the row's own texture-variation
 *     columns resolved against the model's directory -- `Creature\Wolf\WolfSkinDiseased.blp` and the
 *     like. `classes/unit.ts`' display-id path already does this and it already WORKS: measured in
 *     Northshire, every wolf, rabbit, riding horse and peasant had real BLPs bound to texture types
 *     11/12.
 *   15 451 rows have a non-zero `extraInfoID`. Those are CHARACTER models -- `HumanMale.m2` and its
 *     siblings -- and their texture types are 1 (body), 6 (hair) and 2 (cloak), the runtime slots a
 *     `CreatureDisplayInfo` row cannot fill. Measured in the same session: seventeen such units, every
 *     one of them with all 63 geosets visible and types 1/6/2 bound to `null`. That is the black
 *     silhouette, and it is the whole of it.
 *
 * WHAT THIS FILE DOES NOT DO: bake. The player compositor costs ~6 ms of main thread per character and
 * 6-16 HTTP fetches, and a zone of npcs would be many of both. It is not needed, because 3.3.5a SHIPS
 * the answer: `CreatureDisplayInfoExtra.BakeName` names a pre-baked body atlas under
 * `Textures\BakedNpcTextures\`, 256x256 DXT, which `TextureLoader` uploads compressed. One cached
 * fetch per display id replaces the whole bake. See the schema file for the measurement.
 *
 * EVERYTHING ELSE IS THE PLAYER PATH'S, deliberately and by import: `hairGeosetFor`,
 * `facialGeosetsFor`, `hairTextureFor`, `REGION_BASES`, `applyHelmetMasks`, `equipGeosetsFor`,
 * `capeTextureFor` and `attachedItemsFor` are all called here unchanged, and the result is a
 * `CharacterLook` so that `character/dress.ts` dresses an npc with the same three functions it dresses
 * the player with. The only new law is the eleven-column item projection
 * (`character-equipment.ts#npcWornEquipmentFor`) and the baked-texture path below.
 */
import DBC from '../../pipeline/dbc';
import { attachedItemsFor } from './character-attachments';
import {
  CharacterLook,
  CharHairGeosetsRow,
  CharSectionsRow,
  CharacterFacialHairStylesRow,
  ChrRacesRow,
  bodySkinFor,
  capeTextureFor,
  facialGeosetsFor,
  hairGeosetFor,
  hairTextureFor,
} from './character-look';
import {
  HelmetGeosetVisDataRow,
  ItemDisplayInfoRow,
  NpcItemDisplayIds,
  REGION_BASES,
  WornEquipment,
  applyHelmetMasks,
  equipGeosetsFor,
  npcWearsNothing,
  npcWornEquipmentFor,
} from './character-equipment';

/**
 * The directory the pre-baked npc atlases live in. Case is irrelevant -- `net/loader.js#normalizePath`
 * lowercases every path before it reaches the host -- but the DBC-style backslash spelling is kept so
 * this reads like every other asset path in the client.
 */
const BAKED_NPC_DIR = 'Textures\\BakedNpcTextures\\';

/**
 * A `CreatureDisplayInfoExtra` row, as much of it as dressing an npc needs. Field positions are the
 * schema's (`wow-data-parser/dbc/entities/creature-display-info-extra.js`), where the three
 * appearance-dial names were corrected against measured value ranges.
 */
export type CreatureDisplayInfoExtraRow = NpcItemDisplayIds & {
  id: number;
  raceID: number;
  gender: number;
  skinColor: number;
  faceType: number;
  hairStyle: number;
  hairColor: number;
  facialHair: number;
  /** `BakeName`. Empty on 22 of the live table's 15 475 rows; see `resolveNpcLook`. */
  texture: string;
};

/**
 * A humanoid npc's `CreatureDisplayInfo` + `CreatureModelData` rows -> the same `CharacterLook` the
 * player path produces.
 *
 * `bodyLayers` is deliberately EMPTY, and that is not a stub. `character/dress.ts#loadCharacter` calls
 * `cachedComposite(key, [])`, `compositeBody` returns null for an empty list, and
 * `applyCharacterLook` then binds `look.bodyTexture` -- which here is the baked atlas rather than a
 * raw base skin. So an npc costs one texture fetch and no bake, through exactly the same code path,
 * with no branch added to it.
 *
 * Answers null when the extra row is missing, which is a data problem to read on the console; the
 * caller's fallback is the plain display-id path, i.e. the untextured body it would have drawn anyway.
 */
export async function resolveNpcLook(
  displayInfo: { extraInfoID: number; scale: number },
  modelData: { file: string; collisionHeight: number },
): Promise<CharacterLook | null> {
  const extra: CreatureDisplayInfoExtraRow | undefined = await DBC.load(
    'CreatureDisplayInfoExtra',
    displayInfo.extraInfoID,
  );
  if (!extra) {
    console.warn(`npc look: CreatureDisplayInfoExtra has no row ${displayInfo.extraInfoID}`);
    return null;
  }

  const race = extra.raceID;
  const gender = extra.gender;

  const sectionRows = ((await DBC.load('CharSections'))?.records ?? []) as CharSectionsRow[];

  // The 16 region-base SLOTS, in the client's order: the customization writes 0..3, a worn helm's
  // masks force some of those back, and only then do the equipment branches add and disable. Same
  // sequence as `resolveCharacterLook`, and it has to be -- the branches address slots by index.
  const slots = [...REGION_BASES];

  const hairRows = ((await DBC.load('CharHairGeosets'))?.records ?? []) as CharHairGeosetsRow[];
  const hairGeoset = hairGeosetFor(hairRows, race, gender, extra.hairStyle);
  if (hairGeoset !== null) {
    slots[0] = hairGeoset;
  }

  const facialRows = ((await DBC.load('CharacterFacialHairStyles'))?.records ??
    []) as CharacterFacialHairStylesRow[];
  const facialGeosets = facialGeosetsFor(facialRows, race, gender, extra.facialHair);
  if (facialGeosets !== null) {
    for (const id of facialGeosets) {
      slots[Math.floor(id / 100)] = id;
    }
  }

  const worn = await resolveNpcEquipment(extra);
  if (worn) {
    const helmetRows = worn.helm
      ? (((await DBC.load('HelmetGeosetVisData'))?.records ?? []) as HelmetGeosetVisDataRow[])
      : [];
    applyHelmetMasks(slots, worn, helmetRows, race, gender);
  }

  // The baked atlas, or -- for the 22 rows that carry no name -- the raw base skin, which draws a
  // correctly-coloured but undressed body with a blank face. A warning rather than a silent
  // half-picture, because "this npc is naked" is exactly the kind of thing that reads as a bug later.
  //
  // `0` as the excluded-flag set: an npc is ENTITLED to the `0x08` npc-only and `0x04` Death Knight
  // rows a character-create dial excludes. See `PLAYER_SECTION_FLAGS` in `character-look.ts`.
  let bodyTexture: string | null = extra.texture ? `${BAKED_NPC_DIR}${extra.texture}` : null;
  if (!bodyTexture) {
    bodyTexture = bodySkinFor(sectionRows, race, gender, extra.skinColor, 0);
    console.warn(
      `npc look: CreatureDisplayInfoExtra ${extra.id} carries no BakeName; binding the raw base ` +
        `skin ${bodyTexture ?? '(none)'} -- the body draws undressed`,
    );
  }

  const raceRow: ChrRacesRow | undefined = await DBC.load('ChrRaces', race);

  return {
    modelPath: modelData.file,
    // `|| 1` and `|| 0` for the same reason `resolveCharacterLook` uses them: the DBC's float columns
    // read 0 for a row that carries nothing, and a zero scale is as unusable as a missing one.
    scale: displayInfo.scale || 1,
    collisionHeight: (modelData.collisionHeight || 0) * (displayInfo.scale || 1),
    bodyTexture,
    // EMPTY ON PURPOSE -- the bake is already on the asset host. See the doc above.
    bodyLayers: [],
    compositeKey: `npc:${extra.id}`,
    hairTexture: hairTextureFor(sectionRows, race, gender, extra.hairStyle, extra.hairColor, 0),
    capeTexture: capeTextureFor(worn),
    geosets: worn ? equipGeosetsFor(slots, worn) : new Set([0, ...slots]),
    // Helm and shoulders only: `CreatureDisplayInfoExtra` has no weapon columns at all, so `held` is
    // three nulls and `attachedItemsFor` produces nothing for the hands. See `npcWornEquipmentFor`.
    attachments:
      worn && raceRow ? attachedItemsFor(worn, raceRow.clientPrefix ?? '', gender) : [],
  };
}

/**
 * The worn `ItemDisplayInfo` rows for an npc, or null when the extra row references no item.
 *
 * Null is the point, exactly as it is on the player path: `ItemDisplayInfo` is 6.7 MB over the wire,
 * and an npc that wears nothing must not pull it. The table is loaded once per session and shared
 * through `DBC.load`'s static cache, so in practice the first dressed npc (or the player) pays for
 * every later one.
 */
async function resolveNpcEquipment(
  extra: CreatureDisplayInfoExtraRow,
): Promise<WornEquipment | null> {
  if (npcWearsNothing(extra)) {
    return null;
  }
  const table = await DBC.load('ItemDisplayInfo');
  if (!table) {
    console.warn('npc look: ItemDisplayInfo did not load -- the npc draws undressed');
    return null;
  }
  return npcWornEquipmentFor(extra, (displayId) => {
    // `DBC` indexes its records by id onto itself (`pipeline/dbc/index.js#index`), so this is a
    // property read and not a scan of 57 986 rows.
    const row = (table as unknown as Record<number, ItemDisplayInfoRow | undefined>)[displayId];
    if (!row) {
      console.warn(`npc look: ItemDisplayInfo has no row ${displayId}`);
      return null;
    }
    return row;
  });
}
