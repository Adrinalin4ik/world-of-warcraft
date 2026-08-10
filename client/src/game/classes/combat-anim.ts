/**
 * Which melee swing clip a unit plays -- the reference's `swing_anim_main` / `swing_anim_off`
 * (`samples/benilla/crates/benilla/src/creature_anim/select.rs:661-686`, byte-verified there against
 * the client's own `0x6246a0`), keyed on the WIELDED ITEM's `(class, subclass)`.
 *
 * Every id below is an `AnimationData.dbc` id, the same currency `classes/unit.ts` arms with, and
 * every one is the reference's:
 *
 *   16 AttackUnarmed · 17 Attack1H · 18 Attack2H · 19 Attack2HL · 85 Attack1HPierce
 *   87 AttackOff · 88 AttackOffPierce · 117 AttackUnarmedOff
 *
 * ## Where the item comes from, and the honest limit
 *
 * The wire tells us the equipped item ENTRY, not its class:
 *
 *  - a creature or NPC carries `UNIT_VIRTUAL_ITEM_SLOT_ID` (`+0x0032`, three u32 entries -- main,
 *    off, ranged). In 3.3.5a these are ITEM ENTRY ids; in 2.x the same field held display ids and a
 *    reader written for that build looks up nothing.
 *  - a player carries `PLAYER_VISIBLE_ITEM_16_ENTRYID` for the mainhand and `..._17_...` for the
 *    offhand (`enums.ts#PlayerField`; slot 16 is `EQUIPMENT_SLOT_MAINHAND` one-based).
 *
 * `Item.dbc` then gives `classID`/`subClassID` for an entry
 * (`wow-data-parser/dbc/entities/item.js`). It is a small table and is loaded once.
 *
 * THE LIMIT, STATED: until that table lands, and for any entry it does not contain, this answers
 * `AttackUnarmed`. That is the reference's own fallback for an empty hand -- `swing_anim_main(None)`
 * is 16 -- so it is never a clip a model does not have, but a two-hander swung before the DBC
 * resolves does look like a punch for the first swing or two. Answering nothing instead would mean
 * no swing at all, which is the symptom this file exists to remove.
 */
import DBC from '../pipeline/dbc';
import type Unit from './unit';

/** `AttackUnarmed` -- the reference's fallback for an empty or non-weapon hand (`select.rs:673`). */
export const ATTACK_UNARMED = 16;
const ATTACK_1H = 17;
const ATTACK_2H = 18;
const ATTACK_2HL = 19;
const ATTACK_1H_PIERCE = 85;
const ATTACK_OFF = 87;
const ATTACK_OFF_PIERCE = 88;
const ATTACK_UNARMED_OFF = 117;

/** `ItemClass::WEAPON`. Anything else in the hand swings unarmed. */
const ITEM_CLASS_WEAPON = 2;
/** `ItemSubclassWeapon::DAGGER`, the one subclass with its own pierce clips. */
const WEAPON_DAGGER = 0xf;

/** entry -> subclass, for weapons only. Empty until `primeItems` resolves. */
const weaponSubclass = new Map<number, number>();
let loading: Promise<void> | null = null;

/** Load `Item.dbc` once; shared by every caller, for the same reason `faction.ts` shares its load. */
export function primeItems(): Promise<void> {
  if (loading === null) {
    loading = Promise.resolve(DBC.load('Item'))
      .then((table: { records?: Array<{ id: number; classID: number; subClassID: number }> }) => {
        for (const record of table?.records ?? []) {
          // Only weapons are indexed: every other class answers `AttackUnarmed` anyway, and the map
          // is then a fraction of the table's ~40k rows.
          if (record && record.classID === ITEM_CLASS_WEAPON) {
            weaponSubclass.set(record.id, record.subClassID);
          }
        }
      })
      .catch(() => {
        // `DBC.load` logs and answers empty; an empty map is the "unarmed" path above.
      });
  }
  return loading;
}

/**
 * `swing_anim_main` (`select.rs:664-675`), verbatim on the subclass table.
 *
 * The five arms are 1H axe/mace/sword/exotic/misc, 2H axe/mace/sword/exotic, polearm/staff/spear/
 * fishing pole, dagger, and everything else -- fist weapons, bows, guns, wands and obsolete(9)
 * included, which all punch.
 */
function mainFor(subclass: number | undefined): number {
  switch (subclass) {
    case 0x0: case 0x4: case 0x7: case 0xb: case 0xe:
      return ATTACK_1H;
    case 0x1: case 0x5: case 0x8: case 0xc:
      return ATTACK_2H;
    case 0x6: case 0xa: case 0x11: case 0x14:
      return ATTACK_2HL;
    case WEAPON_DAGGER:
      return ATTACK_1H_PIERCE;
    default:
      return ATTACK_UNARMED;
  }
}

/** `swing_anim_off` (`select.rs:680-686`): a dagger stabs, another weapon swings, a bare hand punches. */
function offFor(subclass: number | undefined): number {
  if (subclass === WEAPON_DAGGER) {
    return ATTACK_OFF_PIERCE;
  }
  return subclass === undefined ? ATTACK_UNARMED_OFF : ATTACK_OFF;
}

/**
 * The clip for one swing. `offhand` is `SMSG_ATTACKERSTATEUPDATE`'s `HitInfo` bit `0x4`.
 *
 * The DBC load is kicked off here rather than at boot so a client that never fights never fetches
 * `Item.dbc` -- the first swing answers unarmed and every later one is right.
 */
export function swingAnimation(unit: Unit, offhand: boolean): number {
  void primeItems();
  const entry = offhand ? unit.equippedOffhand : unit.equippedMainhand;
  const subclass = entry ? weaponSubclass.get(entry) : undefined;
  return offhand ? offFor(subclass) : mainFor(subclass);
}
