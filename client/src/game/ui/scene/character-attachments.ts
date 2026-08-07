/**
 * What HANGS OFF the character rather than painting into its body atlas (piece 9): weapons, shields,
 * the shoulder pair and the helm's own model.
 *
 * The split from `character-equipment.ts` is the same one the reference draws
 * (`entities/equipment/{resolve,spawn}.rs` against `characters/sections.rs`): that file turns worn
 * items into TEXTURE LAYERS and GEOSET ids -- things that change the body's own mesh and skin -- while
 * this one turns them into SEPARATE `.m2` FILES parented to a bone. A cloak is the boundary case and it
 * belongs to the other file, because in 3.3.5a the cape is a body geoset (1501+v) with a type-2 sheet,
 * not an attached model.
 *
 * THE PLACEMENT CONVENTION, and where it comes from. An attached item is parented to the body bone the
 * attachment record names, at a bone-local offset, with **no rotation of its own** -- the item model's
 * origin IS the grip and the bone's animated frame supplies the orientation
 * (`benilla/crates/benilla/src/entities/equipment/mod.rs:14-18`, and the offset law verbatim at
 * `benilla-assets/src/model.rs:429-435`: `offset = wow_to_bevy(position) - pivot_bevy(bone)`).
 *
 * MEASURED ON THE REAL 3.3.5a BYTES, because the research left it as an open question (§6 unknown 7,
 * "attachment ids ... taken from the reference, not measured here"). A direct dump of
 * `Character\Human\Male\HumanMale.m2` (version 264, 1 585 376 bytes, 138 bones) gives **39 attachment
 * records**, ids 0..22, 26..38 and 47..49, and for every single one of them
 *
 *     attachment.position == bones[attachment.bone].pivotPoint   (max |difference| = 0.000000)
 *
 * so on a character the bone-local offset is exactly zero and the attach bones are leaves sitting on
 * the attach point -- which is what the reference says of 1.12.1's file too. The offset is still
 * subtracted below rather than assumed away: it is the general law, an `Item\` or creature model need
 * not have it zero, and a hardcoded zero would be a coincidence dressed as a rule.
 *
 * The ids this file needs, with the bone each sits on and its raw model-space position, from that dump:
 *
 *     id  0  bone 123  [-0.0739,  0.5751, 1.0362]   left forearm -- a DRAWN shield
 *     id  1  bone 125  [-0.0585, -0.4757, 0.9041]   right hand -- the drawn mainhand
 *     id  2  bone 126  [-0.0585,  0.4710, 0.9041]   left hand -- a drawn non-shield offhand
 *     id  5  bone 111  [-0.0602, -0.2109, 1.7254]   right shoulder
 *     id  6  bone 112  [-0.0509,  0.2109, 1.7254]   left shoulder
 *     id 11  bone 115  [ 0.0520,  0.0000, 2.0272]   head -- the helm
 *
 * The right/left reading is the reference's (`equipment/mod.rs:54-86`); what the data adds is that the
 * pairs are Y-mirrored with the SAME sign convention in both (hands -0.4757/+0.4710, shoulders
 * -0.2109/+0.2109), so id 1 and id 5 are the same side as each other and id 2 and id 6 the other -- a
 * left/right swap would show up as both a weapon and a pauldron on the wrong side, not one of them.
 * Height is the other confirmation: id 11 at z 2.0272 is the crown of a 1.96-tall body, ids 5/6 at
 * 1.7254 are shoulder height, ids 1/2 at 0.9041 are hands hanging at the hips.
 */
import type { ItemDisplayInfoRow, WornEquipment } from './character-equipment';

/**
 * The body attachment ids piece 9 uses. Measured on `HumanMale.m2` -- see the file comment for the
 * dump and for why each one is the point it claims to be.
 *
 * The stowed family (26/27 back, 28 centre back, 30/31 lower back, 32/33 hips) exists on the file and
 * is deliberately NOT here: character select never stows anything (see `SELECT_SHEATH_MELEE`), so an id
 * with no reader would be an invitation to guess. `unit.ts` is where they belong when the world path
 * wants them.
 *
 * The `SMSG_CHAR_ENUM` slot numbers these items come FROM -- the held triple 15/16/17 and the shoulder
 * slot 2 -- live in `character-equipment.ts` beside the helm and cloak slots, because `wearsNothing`
 * there has to know about them too and the dependency between the two files must run one way. A
 * pauldron is absent from that file's BODYSLOT list on purpose: it paints no body region at all
 * (`ItemDisplayInfo` 1057's eight region columns are empty), it is purely two models.
 */
export const ATTACH_SHIELD = 0;
export const ATTACH_HAND_RIGHT = 1;
export const ATTACH_HAND_LEFT = 2;
export const ATTACH_SHOULDER_RIGHT = 5;
export const ATTACH_SHOULDER_LEFT = 6;
export const ATTACH_HELM = 11;

/**
 * The unit sheath state character select draws with: **1 = melee drawn**.
 *
 * This is the whole "weapons in the hands, ranged skipped" rule, and it is not a special case coded
 * for this screen -- it is the world's own `placement` law evaluated at `unitSheath = 1`, which is
 * exactly how the reference reaches it (`attach/glue_preview.rs:501`,
 * `placement(held_slot, item.inventory_type, 0, 1)`). The melee arm puts the mainhand in the right
 * hand and the offhand in the left hand (or on the forearm if it is a shield), and the ranged arm only
 * yields a point while `unitSheath == 2`, so a bow simply resolves to nothing.
 *
 * `itemSheath` is passed 0 for the same reason: the enum carries no per-item sheath type (vmangos
 * `BuildEnumData` sends displayId + inventoryType only), and at `unitSheath = 1` the melee arm never
 * reads it. A stowed weapon on this screen would need a byte the server does not send.
 */
export const SELECT_SHEATH_MELEE = 1;

/** `InventoryType` values `placement` branches on. */
const INVTYPE_SHIELD = 14;
const INVTYPE_RANGED = 15;

/**
 * Where one held item hangs, or null for "draws nothing".
 *
 * A verbatim port of `benilla/crates/benilla/src/entities/equipment/resolve.rs:34-67`, which took it
 * from the client's `0x47a070` jump table. Only the DRAWN half is reachable from this screen
 * (`unitSheath` is always `SELECT_SHEATH_MELEE`), so the stowed arm is left out rather than
 * transcribed and never run -- see `ATTACH_*` above for the same reasoning about the stow ids.
 *
 * The three real behaviours, in the order the roster exercises them:
 *  - **slot 0, any inventory type -> the right hand.** A two-hander is not special: `Gesf` carries
 *    display 2380 at slot 15 with `inventoryType 17` (TWOHAND) and `Sgh` display 5194 with
 *    `inventoryType 21` (WEAPONMAINHAND), and both take the same branch.
 *  - **slot 1 -> the left FOREARM for a shield, the left hand otherwise.** `Sgh` carries display 18730
 *    at slot 16 with `inventoryType 14`, so the shield branch is live data and not a staged row.
 *  - **slot 2 -> nothing at all.** `Aag` carries display 8106 at slot 17 with `inventoryType 15`
 *    (RANGED, `Bow_1H_Short_A_01`), and a ranged weapon is invisible unless the unit is ranged-drawn.
 *    The reference's note on why this is a real detach rather than a re-point: byte-verified
 *    `0x7130a0` is a pure unlink, uniform across bow/gun/crossbow/thrown/wand.
 *
 * All four inventory types above were read off the live server for the five roster characters, not
 * assumed from the item name.
 */
export function placement(
  heldSlot: number,
  inventoryType: number,
  itemSheath: number,
  unitSheath: number,
): number | null {
  if (heldSlot === 2) {
    // Ranged: in hand only while ranged-drawn, and then a bow takes the LEFT hand while a
    // gun/crossbow/wand/thrown takes the right (`0x611e10`'s invType test).
    if (unitSheath !== 2) {
      return null;
    }
    return inventoryType === INVTYPE_RANGED ? ATTACH_HAND_LEFT : ATTACH_HAND_RIGHT;
  }
  if (heldSlot !== 0 && heldSlot !== 1) {
    return null;
  }
  if (unitSheath === 1) {
    if (heldSlot === 0) {
      return ATTACH_HAND_RIGHT;
    }
    return inventoryType === INVTYPE_SHIELD ? ATTACH_SHIELD : ATTACH_HAND_LEFT;
  }
  // The stowed arm. Unreachable from character select; see the doc above.
  void itemSheath;
  return null;
}

/**
 * Which of an item display's two model columns a slot shows, and which `Item\ObjectComponents\`
 * sub-directory the file lives in.
 *
 * The directory is NOT derivable from the model name and neither is the texture: `ItemDisplayInfo`
 * 18730 is `Shield_Round_A_01.mdx` skinned `Buckler_Damaged_A_01Purple` -- a buckler texture on a
 * round-shield mesh, in `Shield\` -- and 2380 is `Sword_2H_Claymore_A_01.mdx` skinned
 * `Sword_2H_Claymore_A_01Rusty`. Both read off the live table. So the kind decides the directory and
 * the row's own column decides the texture, exactly as the reference warns
 * (`equipment/mod.rs:277-295`, "never derived from the model name").
 *
 * The shoulder pair is the only two-column row shape: `leftModelFile`/`leftModelTexture` is the LEFT
 * pauldron and `rightModelFile`/`rightModelTexture` the right, each with its own texture name (they
 * happen to be equal on every row sampled -- 1057 is `Shoulder_Leather_A_01Brown` twice -- but the
 * columns are independent and are read independently). Measured: 4321 of the 57 986 rows carry an
 * `LShoulder*`/`RShoulder*` pair.
 */
export type ItemModelKind = 'weapon' | 'shield' | 'shoulderLeft' | 'shoulderRight' | 'helm';

const ITEM_MODEL_DIRS: Record<ItemModelKind, string> = {
  weapon: 'Weapon',
  shield: 'Shield',
  shoulderLeft: 'Shoulder',
  shoulderRight: 'Shoulder',
  helm: 'Head',
};

/** One model to load and hang on the body. */
export type AttachedItem = {
  /** The body attachment id -- one of the `ATTACH_*` above. */
  attachId: number;
  /** `Item\ObjectComponents\<dir>\<file>`, `.mdx` as the DBC spells it; `M2Blueprint` rewrites it. */
  modelPath: string;
  /**
   * The model's own skin, for its **texture type 2** slot, or null when the row names none.
   *
   * Type 2, measured, not assumed: every `Item\ObjectComponents\` model dumped declares its first
   * texture as type 2 and nothing else runtime -- `Sword_2H_Claymore_A_01.m2` is `[type 2 (runtime),
   * type 0 ARMORREFLECT3.BLP]`, and the shield, both pauldrons and `Helm_Cloth_A_01_HuM.m2` each
   * declare exactly one texture, type 2. That is the same slot the cloak sheet uses, which is why
   * `M2Material.skins` calls it `object` rather than `cape`.
   */
  texturePath: string | null;
  /** For the console line when a body has no such attachment point. */
  kind: ItemModelKind;
};

/**
 * A helm's per-race-and-sex file name.
 *
 * `<stem>_<clientPrefix><M|F>.m2`, and the underscore is real: the live host answers 200 for
 * `item/objectcomponents/head/helm_cloth_a_01_hum.m2` and 404 for both `..._01hum.m2` and the bare
 * `..._01.m2`, so the DBC's `Helm_Cloth_A_01.mdx` names no file that exists on its own.
 *
 * THE PREFIX COMES FROM `ChrRaces.clientPrefix`, NOT FROM A TABLE IN THIS FILE. The reference hardcodes
 * eight (`["Hu","Or","Dw","Ni","Sc","Ta","Gn","Tr"]`, `equipment/mod.rs:303`) because 1.12.1 has eight
 * playable races; 3.3.5a has eleven, and the two it adds are exactly the two on the live roster's far
 * end -- `Sgh` is a Draenei (race 11, prefix `Dr`). Verified fetchable for the pair the reference could
 * not know about: `helm_cloth_a_01_drm.m2` and `helm_cloth_a_01_bem.m2` both answer 200, as do
 * `_gnm`, `_dwf` and `_nim`. Ported literally, the reference's `RACE_PREFIX[(race.clamp(1, 8) - 1)]`
 * would have read **Troll** for a Draenei and for a Blood Elf -- a real 200-answering file, so a wrong
 * helmet with no error anywhere. The column that avoids it is one `character-look.ts` already has in
 * hand from the `ChrRaces` row it looks the display id up in.
 */
export function helmModelFile(stem: string, clientPrefix: string, gender: number): string {
  const bare = stem.replace(/\.(mdx|m2)$/i, '');
  return `${bare}_${clientPrefix}${gender === 1 ? 'F' : 'M'}.m2`;
}

/** `dir` + a file name, or null when the column is empty. */
function itemModel(
  file: string | undefined,
  texture: string | undefined,
  kind: ItemModelKind,
  attachId: number,
): AttachedItem | null {
  if (!file) {
    return null;
  }
  const dir = ITEM_MODEL_DIRS[kind];
  return {
    attachId,
    modelPath: `Item\\ObjectComponents\\${dir}\\${file}`,
    texturePath: texture ? `Item\\ObjectComponents\\${dir}\\${texture}.blp` : null,
    kind,
  };
}

/**
 * Every model a dressed character hangs off its skeleton, in load order.
 *
 * The order is the reference's `held_wants` (`attach/glue_preview.rs:472-519`): helm, then the
 * shoulder pair, then the held triple through `placement`. It is not load-bearing -- each item lands on
 * its own bone and nothing stacks -- but keeping it means a diff against the reference reads straight
 * across.
 *
 * A row whose model column is empty contributes nothing, which is the common case and not a failure:
 * none of the eight body-region slots carries a model at all, and a cloak's row carries a texture with
 * an empty `leftModelFile` (measured: 13963 `Cape_Mage_A_01Black`).
 */
export function attachedItemsFor(
  worn: WornEquipment,
  clientPrefix: string,
  gender: number,
): AttachedItem[] {
  const items: AttachedItem[] = [];

  const helm = worn.helm;
  if (helm?.leftModelFile) {
    items.push({
      attachId: ATTACH_HELM,
      modelPath: `Item\\ObjectComponents\\Head\\${helmModelFile(
        helm.leftModelFile,
        clientPrefix,
        gender,
      )}`,
      texturePath: helm.leftModelTexture
        ? `Item\\ObjectComponents\\Head\\${helm.leftModelTexture}.blp`
        : null,
      kind: 'helm',
    });
  }

  const shoulder = worn.shoulder;
  if (shoulder) {
    // Two independent columns, two models, two attachment points. `leftModelFile` is the LEFT
    // pauldron and hangs on attachment 6; `rightModelFile` is the right and hangs on 5.
    const left = itemModel(
      shoulder.leftModelFile,
      shoulder.leftModelTexture,
      'shoulderLeft',
      ATTACH_SHOULDER_LEFT,
    );
    const right = itemModel(
      shoulder.rightModelFile,
      shoulder.rightModelTexture,
      'shoulderRight',
      ATTACH_SHOULDER_RIGHT,
    );
    if (left) {
      items.push(left);
    }
    if (right) {
      items.push(right);
    }
  }

  worn.held.forEach((held, heldSlot) => {
    if (!held?.row) {
      return;
    }
    const attachId = placement(heldSlot, held.inventoryType, 0, SELECT_SHEATH_MELEE);
    if (attachId === null) {
      return;
    }
    const kind: ItemModelKind = held.inventoryType === INVTYPE_SHIELD ? 'shield' : 'weapon';
    const model = itemModel(held.row.leftModelFile, held.row.leftModelTexture, kind, attachId);
    if (model) {
      items.push(model);
    }
  });

  return items;
}

/** Referenced by `itemModel`'s columns; re-stated so a reader of this file sees the row shape. */
export type { ItemDisplayInfoRow };
