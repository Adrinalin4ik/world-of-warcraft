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

/**
 * The four `AnimationData` Ready idles -- the engaged standing guard, one per weapon bucket
 * (`select.rs:867-877`). NOT combat one-shots: they are looping STATE ids and the gait cascade
 * selects them, which is why they live beside the swing table rather than in it.
 */
const READY_UNARMED = 25;
const READY_1H = 26;
const READY_2H = 27;
const READY_2HL = 28;

/**
 * The ranged Load/Hold ids -- `ranged_load_anim`'s outputs and their Hold twins
 * (`select.rs:585-620`). Every one re-read out of the served `dbfilesclient/animationdata.dbc`
 * (506 rows) rather than taken on trust: 105 LoadBow, 106 LoadRifle, 112 LoadThrown, 109 HoldBow,
 * 110 HoldRifle, 111 HoldThrown. The table carries no wand-specific row at all, which is why the
 * wand borrows the thrown hold.
 */
const LOAD_BOW = 105;
const LOAD_RIFLE = 106;
const LOAD_THROWN = 112;
const HOLD_BOW = 109;
const HOLD_RIFLE = 110;
const HOLD_THROWN = 111;

/**
 * `VictimState`, the outcome word `SMSG_ATTACKERSTATEUPDATE` carries after its sub-damage block.
 *
 * Values cross-checked against the reference's own two independent uses -- the combat-text picker
 * (`combat_text/law.rs:149-156`, "victim states 2 dodge / 3 parry / 5 block") and the defense-anim
 * table (`select.rs:587-603`) -- and against the blood gate, which spurts only for 1 and 4
 * (`creature_anim/blood.rs:83-84`). They agree, and the numbering is not version-dependent the way a
 * `HitInfo` bit is.
 */
const VICTIM_MISS = 0;
const VICTIM_HIT = 1;
const VICTIM_DODGE = 2;
const VICTIM_PARRY = 3;
const VICTIM_BLOCK = 5;
const VICTIM_EVADE = 6;
const VICTIM_DEFLECT = 8;

/** The defense one-shots -- `defense_anim`'s output ids (`select.rs:587-603`). */
const PARRY_UNARMED = 20;
const PARRY_1H = 21;
const PARRY_2H = 22;
const PARRY_2HL = 23;
const SHIELD_BLOCK = 24;
const DODGE = 30;

/** `ItemClass::WEAPON`. Anything else in the hand swings unarmed. */
const ITEM_CLASS_WEAPON = 2;
/** `ItemSubclassWeapon::DAGGER`, the one subclass with its own pierce clips. */
const WEAPON_DAGGER = 0xf;

/**
 * The ranged `ItemSubclassWeapon` values the ranged idle keys on -- the reference's own match arms
 * `(2,2)`, `(2,3)`, `(2,18)`, `(2,16)`, `(2,19)` (`select.rs:586-592`), all item class 2.
 */
const WEAPON_BOW = 2;
const WEAPON_GUN = 3;
const WEAPON_THROWN = 16;
const WEAPON_CROSSBOW = 18;
const WEAPON_WAND = 19;

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
 * The ENGAGED STANDING IDLE -- the weapon-class Ready pick, `ready_anim` (`select.rs:867-877`,
 * decision 0073, the client's `0x5fd360` arm at `0x5fcdc0`).
 *
 * A THIRD weapon bucketing, and deliberately not `mainFor`'s: the reference's own comment says "the
 * buckets differ from the swing table: fist **and** dagger ready as 1H". So a dagger, which stabs
 * with its own pierce clip when it swings, holds the ordinary one-handed guard when it is idle.
 *
 * The subclass numbers transfer from the reference's 1.12 table unchanged, checked one by one against
 * 3.3.5a `ItemSubclassWeapon`: 1H is axe1H 0, mace1H 4, sword1H 7, exotic 11, fist 13, misc 14,
 * dagger 15; 2H is axe2H 1, mace2H 5, sword2H 8, exotic2 12; 2H-LONG is polearm 6, staff 10, spear 17.
 * Everything else -- bow, gun, crossbow, wand, fishing pole, obsolete(9) -- is `ReadyUnarmed`, which
 * is also what an empty hand gets.
 *
 * Gated on ENGAGEMENT and never on sheath state: the client's arm tests the auto-attack-target guid.
 * See `Unit#readyIdle` for where engagement comes from.
 */
export function readyAnimation(unit: Unit): number {
  void primeItems();
  const entry = unit.equippedMainhand;
  const subclass = entry ? weaponSubclass.get(entry) : undefined;
  switch (subclass) {
    case 0x0: case 0x4: case 0x7: case 0xb: case 0xd: case 0xe: case 0xf:
      return READY_1H;
    case 0x1: case 0x5: case 0x8: case 0xc:
      return READY_2H;
    case 0x6: case 0xa: case 0x11:
      return READY_2HL;
    default:
      return READY_UNARMED;
  }
}

/**
 * THE RANGED AUTO-ATTACK IDLE -- `ranged_load_anim` (`select.rs:573-593`, byte-verified there
 * against the client's `0x5fd460` -> LUT `0x5fd530`), keyed on the RANGED-slot item's subclass.
 *
 * Bow -> LoadBow 105 · Gun/Crossbow -> LoadRifle 106 · Thrown -> LoadThrown 112 · **Wand ->
 * HoldThrown 111** · anything else -> ReadyUnarmed 25.
 *
 * THE REFERENCE'S OWN NOTE, TAKEN RATHER THAN OVERRULED: "**Not** ReadyBow/AttackBow: no code in
 * the client plays those rows." Those two are the obvious-sounding pick -- `AnimationData.dbc`
 * really does carry ReadyBow 29, AttackBow 46 and FireBow 47, so they look like the answer and are
 * measurably not it. Nothing here reads them.
 *
 * All five keys are item class 2 (`ITEM_CLASS_WEAPON`), so `weaponSubclass` already indexes every
 * entry this needs and `primeItems` covers it unchanged.
 *
 * ## THE CALL SITE IS NOT WIRED, and both of its inputs are absent from this client
 *
 * Stated rather than approximated, because inventing the gate would put a drawn-bow pose on a unit
 * that is not shooting. The reference arms this from `sheath CUR == 2 && [+0xd58] & 0x200`, local
 * player only (`select.rs:534-539`), placed AFTER the engaged Ready pick -- the two cannot co-occur,
 * because auto-shot never sets the engaged guid -- and before the chair loops. Here:
 *
 *  - **World-side sheath state does not exist.** `UNIT_FIELD_BYTES_2` byte 0 carries it and nothing
 *    reads it; the only sheath value in the tree is `ui/scene/character-attachments.ts`'s hardcoded
 *    `1` for the character-select screen.
 *  - **Auto-repeat armed does not exist either.** It is local state: the client arms it when the
 *    player casts a spell carrying `AttributesEx2` bit 0x20 and drops it on
 *    `SMSG_CANCEL_AUTO_REPEAT_SPELL`. Derivable -- the attribute is in `Spell.dbc` -- but a lane of
 *    its own, not a line here.
 *
 * So this is the SELECTOR, complete and testable, with the gate named. Until it is wired the owner
 * sees no change from it: a mage's wand attack takes its pose from `spell-anim.ts#castAnimationFor`'s
 * `SpellCastDirected` fallback, and removing THAT is the change filed in that file's header (it would
 * strip the release clip from 58% of `Spell.dbc`, so it is the owner's call, not a side effect here).
 */
export function rangedLoadAnimation(unit: Unit): number {
  void primeItems();
  const entry = unit.equippedRanged;
  const subclass = entry ? weaponSubclass.get(entry) : undefined;
  switch (subclass) {
    case WEAPON_BOW:
      return LOAD_BOW;
    case WEAPON_GUN: case WEAPON_CROSSBOW:
      return LOAD_RIFLE;
    case WEAPON_THROWN:
      return LOAD_THROWN;
    case WEAPON_WAND:
      return HOLD_THROWN;
    default:
      return READY_UNARMED;
  }
}

/**
 * Whether `id` is a ranged LOAD clip -- one that must play ONCE AND FREEZE at full draw rather than
 * loop (`is_ranged_load`, `select.rs:597-600`).
 *
 * The wand's HoldThrown 111 is deliberately NOT in the set: it is already a hold pose, so it has
 * nothing to freeze into and re-arms itself.
 */
export function isRangedLoad(id: number): boolean {
  return id === LOAD_BOW || id === LOAD_RIFLE || id === LOAD_THROWN;
}

/**
 * The Hold a finished Load promotes to -- the completion dispatch `0x5fc3f0`'s slot 11/12/15 arms
 * (`select.rs:602-620`): LoadBow 105 -> HoldBow 109, LoadRifle 106 -> HoldRifle 110, LoadThrown 112
 * -> HoldThrown 111. Anything else holds nothing and stays put, which `null` says.
 *
 * **The promotion is UNCONDITIONAL** (the reference's §5 / decision 1544, stated emphatically there):
 * the `[+0xd24]` ranged-prop and `[+0xd58] & 0x600` test at `0x5fc5bc` belongs to slot 13 -- the
 * Hold's OWN re-arm -- not to the Load's slot 11, which is a bare
 * `mov eax,0x6d ; push eax ; call 0x5fe2f0` at `0x5fc5e9`. Reading that gate onto the Load is named
 * there as "the mistake that would leave a shooter frozen at full draw", so it is not read onto it.
 */
export function rangedHoldFor(loadId: number): number | null {
  if (loadId === LOAD_BOW) return HOLD_BOW;
  if (loadId === LOAD_RIFLE) return HOLD_RIFLE;
  if (loadId === LOAD_THROWN) return HOLD_THROWN;
  return null;
}

/**
 * THE VICTIM'S DEFENSE REACTION, from `SMSG_ATTACKERSTATEUPDATE`'s `VictimState` -- `defense_anim`
 * (`select.rs:587-603`, decision 0279, the client's `$CPP` dispatch `0x624a01`).
 *
 * A dodge or a deflect is one clip; a block is the shield; a PARRY depends on what the victim is
 * holding, because you parry with your own weapon. Note the bucketing is the SWING table's here and
 * not the Ready table's -- a dagger parries with the 1H clip and a fist has its own ParryUnarmed --
 * which is the third and fourth weapon bucketings in this file and the reason each one is separate.
 *
 * `null` for every other outcome, and TWO of those are worth naming because they are asked about:
 *  - a MISS (state 0) plays NO victim animation at all. Nothing dodges, nothing flinches: the attacker
 *    simply contacts nothing, which is why the reference expresses a miss as the ATTACKER's swing
 *    dropping to half speed (`whiffSlowdown`) plus the floating "Miss" text, and not as a victim clip.
 *  - an EVADE (6) likewise.
 * So "промахов" is the attacker's animation and not the victim's, and it is handled there.
 */
export function defenseAnimation(victimState: number, victim: Unit): number | null {
  if (victimState === VICTIM_DODGE || victimState === VICTIM_DEFLECT) {
    return DODGE;
  }
  if (victimState === VICTIM_BLOCK) {
    return SHIELD_BLOCK;
  }
  if (victimState !== VICTIM_PARRY) {
    return null;
  }
  void primeItems();
  const entry = victim.equippedMainhand;
  const subclass = entry ? weaponSubclass.get(entry) : undefined;
  switch (subclass) {
    case 0x0: case 0x4: case 0x7: case 0xb: case 0xe: case 0xf:
      return PARRY_1H;
    case 0x1: case 0x5: case 0x8: case 0xc:
      return PARRY_2H;
    case 0x6: case 0xa: case 0x11:
      return PARRY_2HL;
    case 0xd:
      return PARRY_UNARMED;
    default:
      // Ranged, obsolete, an oddball, or an empty hand: the reference bails rather than substituting a
      // clip, and so does this. You cannot parry with a bow.
      return null;
  }
}

/**
 * Does this outcome mean the attacker's weapon contacted NOTHING? -- `is_whiff` (`impact.rs:108-110`,
 * the client's gate `0x624ca0`).
 *
 * Miss, dodge and evade. A parry or a block still CONTACTS -- steel meets steel or shield -- so
 * neither slows the swing. The reference's consequence is the whiff slow-down: the attacker's
 * in-flight swing drops to half speed for its remainder (`0x712910`, decision 0279), which is what a
 * missed swing looks like.
 */
export function isWhiff(victimState: number): boolean {
  return victimState === VICTIM_MISS || victimState === VICTIM_DODGE
    || victimState === VICTIM_EVADE;
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
