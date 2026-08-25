/**
 * THE WORLD CURSOR'S CLASSIFIER -- which `Interface\Cursor\<stem>.blp` the pointer should wear.
 *
 * A port of `CGWorldFrame`'s classifier (`0x4828d0` -> the unit branch `0x482200`) as the reference
 * has it byte-verified in `samples/benilla/crates/benilla/src/target/cursor_mode.rs`. The SHAPE is
 * taken from there in full -- the service ladder's lowest-bit-wins order, the loot/skin/attack legs,
 * and the fact that the grayed `Unable*` twin comes from a DIFFERENT range gate per mode. Every
 * version-numbered NUMBER is not, and each says where it came from below.
 *
 * ## What this file is NOT
 *
 * It is a pure function of one hovered unit and the local player. It does no picking, touches no
 * DOM, and knows nothing about how a cursor is drawn -- `game/ui/world-cursor.ts` turns a stem into
 * a CSS cursor and `pages/game/index.tsx` decides how often to ask. That split is deliberate: the
 * cadence is a frame-budget decision with a measurement behind it and does not belong in the law.
 *
 * ## The three legs the reference has and this does not, each with its reason
 *
 *  - **GameObjects.** The reference classifies a hovered GameObject too (a mailbox's Mail, a vein's
 *    Mine, a plaque's Inspect), keyed off `Lock.dbc`/`LockType.dbc` and the GO's template. This
 *    client's pick (`world/pick.ts`) admits `OBJECT_TYPE_UNIT`/`_PLAYER` only and there is no
 *    GameObject template query at all, so there is no hovered GO to classify. Declared, not faked.
 *  - ~~**The QUESTGIVER leg's quest-status gate.**~~ **MODELLED**, and it was a real defect rather
 *    than a cosmetic gap. `serviceCursor` requires the unit's cached `SMSG_QUESTGIVER_STATUS` to be
 *    outside {NONE, UNAVAILABLE} before bit 1 means "talk to me" (`cursor_mode.rs:642-645`, and the
 *    reference records a real bug caused by skipping it). This file used to say that opcode "is in
 *    `network/game/opcode.js` with no subscriber, so the status is genuinely unknown here" and hard-code
 *    `false` as the conservative arm -- reasoning that a questgiver "almost all of them" also carries
 *    GOSSIP and so still gets Speak off bit 0.
 *
 *    **The exception was not rare, and hard-coding false was not conservative.** `quest.ts#handleStatus`
 *    has subscribed to both status opcodes since the overhead markers were built, so the status stopped
 *    being unknown; and a QUESTGIVER-ONLY npc (`npcflag = 2`, no GOSSIP bit) then classified `null`.
 *    Because `pages/game/index.tsx#interactWith` dispatches off THIS classification rather than
 *    re-reading the flags, that one `false` cost the cursor AND the click together: Northshire's Eagan
 *    Peltskinner highlighted on hover, wore a `Point`, sent no `CMSG_GOSSIP_HELLO`, and could not be
 *    talked to at all -- while a gold `?` sat over his head off the very status map this gate was
 *    declining to read. Every questgiver that carries GOSSIP kept working, which is exactly what made
 *    it look like one broken NPC instead of one missing input.
 *  - **The loot leg's Pickup/LootAll split and the skin leg's learned-Skinning precondition.** Both
 *    are modelled: the auto-loot half needs a CVar this client's loot code does not have (there is
 *    no loot code), so `lootCursor` takes the effective flag as an argument and the caller passes
 *    the shift key alone -- which the reference says IS the whole 1.12 mechanism
 *    (`cursor_mode.rs:461-468`). The Skinning precondition is real and reads the player's known
 *    spells.
 */
import { DIALOG_STATUS } from '../../network/game/object/quest';
import { goIsActivatable } from '../../network/game/object/update-object/game-object-fields';
import type Unit from '../classes/unit';
import { REACTION_HOSTILE, REACTION_NEUTRAL, reactionFor } from './faction';

/** `ObjectType` 4 -- a peer player rather than a creature. */
const OBJECT_TYPE_PLAYER = 4;

/**
 * The world cursor's modes, named by their BLP stem in `interface/cursor/`.
 *
 * Every stem here was **header-decoded off the served asset host** in round 22 and is present: all
 * BLP2, palettized, 32x32. That check is why this enum is smaller than the reference's -- `Repair`
 * is in the reference's table but is never produced by the classifier (the ladder does not consult
 * the REPAIR bit), and the six stems a later expansion's name list would have suggested
 * (`pointwarning`, `sell`, `openhand`, `crosshairs`, `ui-cursor-move`, `lock`) **404**.
 */
export type CursorKind =
  | 'Point'
  | 'Attack'
  | 'Speak'
  | 'Pickup'
  | 'LootAll'
  | 'Interact'
  | 'Buy'
  | 'Trainer'
  | 'Taxi'
  | 'Skin';

/** A resolved cursor: the mode, and whether it is the grayed `Unable<Mode>` twin. */
export interface WorldCursorMode {
  kind: CursorKind;
  unable: boolean;
}

export const CURSOR_POINT: WorldCursorMode = { kind: 'Point', unable: false };

/**
 * The BLP stem for a resolved mode.
 *
 * `Point` has **no `Unable` twin on the asset host** (measured round 22: `unablepoint.blp` is not
 * served), which is also the reference's reading -- so an unable Point stays `Point`.
 */
export function cursorStem(mode: WorldCursorMode): string {
  return mode.unable && mode.kind !== 'Point' ? `Unable${mode.kind}` : mode.kind;
}

/**
 * `UNIT_NPC_FLAGS` bits, **3.3.5a values**.
 *
 * THE REFERENCE IS NOT THE AUTHORITY ON THESE and its own comment says so: its table is "vmangos
 * `UnitDefines.h`, 1.12 values -- later expansions differ" (`cursor_mode.rs:145`), where VENDOR is
 * 0x4 and INNKEEPER 0x80. WotLK inserted the three trainer sub-kinds and the four vendor sub-kinds,
 * which shifts every bit above GOSSIP/QUESTGIVER.
 *
 * **THE ONLY SOURCE FOR THESE VALUES IS A SERVER IMPLEMENTATION** -- TrinityCore 3.3.5's
 * `UNIT_NPC_FLAG_*` enum in `UnitDefines.h`. Nothing the client ships names them: they are engine
 * constants, absent from FrameXML (which never reads the field) and from every DBC. That is the same
 * standing this repo already gives `CMSG_SET_ACTION_BUTTON`'s `u8` prefix and
 * `UNIT_BYTES_2_OFFSET_SHAPESHIFT_FORM`, and it is labelled here for the same reason.
 *
 * CORROBORATED LIVE rather than trusted -- see the round-23 entry in `task-9-report.md` for the
 * measured `npcFlags` of Northshire's own NPCs against what each one visibly is.
 */
export const NPC_FLAG = {
  GOSSIP: 0x00000001,
  QUESTGIVER: 0x00000002,
  TRAINER: 0x00000010,
  TRAINER_CLASS: 0x00000020,
  TRAINER_PROFESSION: 0x00000040,
  VENDOR: 0x00000080,
  VENDOR_AMMO: 0x00000100,
  VENDOR_FOOD: 0x00000200,
  VENDOR_POISON: 0x00000400,
  VENDOR_REAGENT: 0x00000800,
  /** Never consulted by the ladder -- kept because its ABSENCE from the ladder is the fact. */
  REPAIR: 0x00001000,
  FLIGHTMASTER: 0x00002000,
  SPIRITHEALER: 0x00004000,
  SPIRITGUIDE: 0x00008000,
  INNKEEPER: 0x00010000,
  BANKER: 0x00020000,
  PETITIONER: 0x00040000,
  TABARDDESIGNER: 0x00080000,
  BATTLEMASTER: 0x00100000,
  AUCTIONEER: 0x00200000,
  STABLEMASTER: 0x00400000,
} as const;

/** Every VENDOR sub-kind folded together -- the ladder tests "is a vendor", not which shelf. */
const ANY_VENDOR =
  NPC_FLAG.VENDOR
  | NPC_FLAG.VENDOR_AMMO
  | NPC_FLAG.VENDOR_FOOD
  | NPC_FLAG.VENDOR_POISON
  | NPC_FLAG.VENDOR_REAGENT;

/** Every TRAINER sub-kind folded together, for the same reason. */
const ANY_TRAINER = NPC_FLAG.TRAINER | NPC_FLAG.TRAINER_CLASS | NPC_FLAG.TRAINER_PROFESSION;

/**
 * `GameObjectFlags` bits that suppress interaction: `0x1` IN_USE and `0x10` NO_INTERACT, as their union.
 * The reference's own constant and its own comment (`cursor_mode.rs:291`).
 */
const GO_FLAG_IN_USE_OR_NO_INTERACT = 0x11;

/**
 * `GO_FLAG_INTERACT_COND` (`0x4`) -- usable ONLY while the per-player activate bit is set. The
 * reference: "this is the quest gate: a quest chest/goober carries it, an ordinary door does not"
 * (`cursor_mode.rs:293-294`).
 */
const GO_FLAG_INTERACT_COND = 0x4;

/**
 * `UNIT_FLAG_SKINNABLE` in `UNIT_FIELD_FLAGS`.
 *
 * `0x04000000` in **both** 1.12 (`cursor_mode.rs:166`) and 3.3.5a, and the value is already asserted
 * in this repo: `update-object/unit-fields.ts`'s header names this bit in that word. Bit 26.
 */
const UNIT_FLAG_SKINNABLE = 0x04000000;

/** `UNIT_DYNFLAG_LOOTABLE` -- `UNIT_DYNAMIC_FLAGS` bit 0. */
const DYNFLAG_LOOTABLE = 0x01;

/**
 * The NPC-service gray gate: 5.5556 yd, squared 30.864.
 *
 * The reference byte-locates it as the client's own `0xb4b32c` cell checked at `0x482320`
 * (`cursor_mode.rs:171-175`), boundary-inclusive. Not a version-numbered gameplay value -- it is a
 * constant in the classifier itself, and there is nothing in 3.3.5a's own data to check it against,
 * so it is carried across as the reference has it and this is stated rather than implied.
 */
export const SERVICE_RANGE_SQ = 30.864;

/**
 * Attack's gray gate: a FIXED 10.45 yd, squared 109.2025 (`0x80447c`, checked at `0x4826a7`).
 *
 * **NOT the melee reach**, which is the reference's own emphasis: the attack cursor grays at a
 * constant distance that has nothing to do with either combatant's size.
 */
export const ATTACK_RANGE_SQ = 109.2025;

/**
 * The melee interact reach that gates SKIN and LOOT: `max(reachA + reachB + 1.3333, 5.0)`.
 *
 * The 5.0 is a FLOOR, not a cap (`0x6e35bf` / `0x5ec1a4` -- "fcomp-then-keep-larger"), so a small
 * pair always gets 5 yd and a large creature reaches farther. Centre to centre, boundary-inclusive.
 */
const MELEE_OFFSET = 1.33333;
const MELEE_FLOOR = 5.0;

/**
 * `UNIT_FIELD_COMBATREACH`, or 0 for a unit whose create block has not carried it.
 *
 * Absent means 0 and NOT "assume a default": with both terms 0 the reach is exactly the 5.0 floor,
 * which is the reference's own director-measured value against a normal mob -- so an unresolved unit
 * gets the ordinary answer rather than a wrong one.
 */
function combatReach(unit: Unit | null): number {
  return unit?.fields.combatReach ?? 0;
}

/**
 * The SQUARED melee interact reach between two units -- `max(reachA + reachB + 1.3333, 5.0)` squared.
 *
 * Extracted and exported rather than left inline because a SECOND consumer arrived:
 * `ui/interaction-watch.ts` closes an open loot window when the player walks out of exactly this
 * radius, and the cursor greys the Pickup pouch at exactly this radius. Those two must agree or the
 * window shuts while the client's own cursor still says the corpse is lootable -- so there is one
 * function and not two copies of the arithmetic.
 *
 * `classifyUnitCursor` below calls it, so the grey gate and the close gate are literally the same
 * expression evaluated twice.
 */
export function interactReachSq(self: Unit | null, unit: Unit | null): number {
  const reach = Math.max(combatReach(unit) + combatReach(self) + MELEE_OFFSET, MELEE_FLOOR);
  return reach * reach;
}

/**
 * The per-bit service ladder (`0x482336..0x4824e3`, statically unrolled), **lowest bit wins**.
 *
 * Row for row the reference's `service_cursor` (`cursor_mode.rs:428-457`), with its own folding of
 * the rows that share an outcome kept: GOSSIP and QUESTGIVER both land on Speak and GOSSIP is tested
 * first, so they are one condition; so are SPIRITHEALER/SPIRITGUIDE and
 * PETITIONER/TABARDDESIGNER/BATTLEMASTER.
 *
 * Three rows are worth reading twice because they are not what a guess would produce: a **VENDOR
 * shows the Pickup pouch**, an **INNKEEPER shows the generic Interact gear**, and a
 * **BANKER/AUCTIONEER shows Buy**. And **REPAIR is never consulted** -- a repair-only unit falls out
 * of the ladder entirely and lands on the attack/Point leg, exactly as the binary does (`je
 * 0x4826cb`); real repairers all carry VENDOR too.
 *
 * `null` means no consulted bit is set.
 */
export function serviceCursor(service: number, questgiverHasQuest: boolean): CursorKind | null {
  if ((service & NPC_FLAG.GOSSIP) !== 0
    || ((service & NPC_FLAG.QUESTGIVER) !== 0 && questgiverHasQuest)) {
    return 'Speak';
  }
  if ((service & ANY_VENDOR) !== 0) {
    return 'Pickup';
  }
  if ((service & NPC_FLAG.FLIGHTMASTER) !== 0) {
    return 'Taxi';
  }
  if ((service & ANY_TRAINER) !== 0) {
    return 'Trainer';
  }
  if ((service & (NPC_FLAG.SPIRITHEALER | NPC_FLAG.SPIRITGUIDE)) !== 0) {
    return 'Speak';
  }
  if ((service & NPC_FLAG.INNKEEPER) !== 0) {
    return 'Interact';
  }
  if ((service & NPC_FLAG.BANKER) !== 0) {
    return 'Buy';
  }
  if ((service & (NPC_FLAG.PETITIONER | NPC_FLAG.TABARDDESIGNER | NPC_FLAG.BATTLEMASTER)) !== 0) {
    return 'Speak';
  }
  if ((service & NPC_FLAG.AUCTIONEER) !== 0) {
    return 'Buy';
  }
  if ((service & NPC_FLAG.STABLEMASTER) !== 0) {
    return 'Speak';
  }
  return null;
}

/**
 * The loot leg's mode split: `8 + (keyDown(0) ? 8 : 0)` at `0x48252c` -- the single pouch, or the
 * triple `LootAll` while the effective auto-loot is on. In 1.12 the held key alone WAS the whole
 * mechanism, which is what this client has (there is no auto-loot CVar because there is no loot).
 */
export function lootCursor(effectiveAutoLoot: boolean): CursorKind {
  return effectiveAutoLoot ? 'LootAll' : 'Pickup';
}

/**
 * Does a QUESTGIVER-flagged unit actually have a quest for us?
 *
 * The reference's predicate verbatim (`cursor_mode.rs:642-645`):
 * `!matches!(quest_status, None | Some(NONE) | Some(UNAVAILABLE))`. The two excluded values and
 * `undefined` are all "nothing to talk about", so **`UNAVAILABLE` draws its grey `!` and still gets no
 * Speak** -- the marker and the cursor answer different questions and are not meant to agree.
 *
 * The version-numbered part is the enum, not the rule: `NONE` and `UNAVAILABLE` are 0 and 1 in both
 * builds, but they are named through our own 3.3.5a `DIALOG_STATUS` so nothing here carries a literal.
 *
 * **Never-sent reads as no quest**, which is the reference's own rule (`:640-641`): the server sends
 * the status unprompted for every questgiver in range, so its absence is an answer. `:633` records what
 * the gate is FOR -- an NPC carrying QUESTGIVER, no other service bit and no `creature_questrelation`
 * row, where skipping the gate opens an empty gossip frame with a placeholder greeting.
 */
export function questgiverHasQuest(status: number | undefined): boolean {
  return status !== undefined
    && status !== DIALOG_STATUS.NONE
    && status !== DIALOG_STATUS.UNAVAILABLE;
}

/** What the classifier needs from outside the two units. */
export interface CursorInputs {
  /** Squared yards between the two units' centres. Passed in so the caller measures once. */
  distanceSq: number;
  /** Is the auto-loot modifier effectively on -- the shift key, here. */
  autoLoot: boolean;
  /** Has the local player learned a Skinning spell (`0xb700e4`'s role). */
  knowsSkinning: boolean;
  /**
   * Is this unit's cached `SMSG_QUESTGIVER_STATUS` one that means "I have something for you"?
   *
   * Gates the QUESTGIVER leg and nothing else -- see `questgiverHasQuest`, which the caller applies to
   * the status map. Passed in rather than read here because this module holds no network state.
   */
  questgiverHasQuest: boolean;
}

/**
 * The classifier: one hovered unit -> the cursor it should wear.
 *
 * Order is the reference's and it matters -- the service ladder is consulted BEFORE attackability,
 * so a neutral-but-flagged NPC gets its service cursor rather than the sword.
 *
 * Returns `null` where the reference returns `None`: nothing to say about this unit, and the caller
 * falls back to `Point`. A plain corpse, a friendly non-service unit and a friendly player are all
 * that leg.
 */
export function classifyUnitCursor(
  unit: Unit,
  self: Unit | null,
  inputs: CursorInputs,
): WorldCursorMode | null {
  const { distanceSq } = inputs;
  // The melee interact reach: both units' combat reach plus the offset, FLOORED at 5 yd. See
  // `combatReach` for why both terms are currently 0 and what that does and does not affect, and
  // `interactReachSq` for why the arithmetic lives in a shared function now.
  const inMelee = distanceSq <= interactReachSq(self, unit);

  /**
   * A WORLD OBJECT -- and it is answered FIRST, before every unit leg below.
   *
   * First because none of them apply: a bush has no reaction, no npc flags, no `dead`, and reading
   * `unit.fields` on it would answer the defaults of a bag that was never written. `gameObject` being
   * non-null is exactly the "is this an object" test, which is why it is null on everything else
   * (`classes/unit.ts#gameObject`).
   *
   * THE GATE IS THE REFERENCE'S, both terms verbatim (`cursor_mode.rs:420-425`, with its own flag
   * constants at `:291-297`):
   *
   *   - `0x11` -- IN_USE (`0x1`) or NO_INTERACT (`0x10`) -- suppresses interaction outright.
   *   - `INTERACT_COND` (`0x4`) means the object is usable ONLY while its per-player activate bit is
   *     set. The reference names what carries it: "a quest chest/goober carries it, an ordinary door
   *     does not". So this is the quest gate, and it is the same bit as the sparkle -- the server sets
   *     both from `GameObject::ActivateToQuest`. A crate that is not our objective is not clickable and
   *     does not glow, from one flag.
   *
   * `Interact` is the kind: the hand, not the sword and not the speech bubble. `unable` beyond service
   * range for the same reason the unit legs use it -- there is no auto-approach in this client, so a
   * send from out of range would be silently refused and read as a broken click.
   *
   * NOT PORTED, and named: the reference's per-TYPE table -- the strategy vtable overrides that make a
   * fishing bobber or a chair never highlightable, and the per-type interact ranges (`:285-287`). Those
   * need `type` from the template query, which arrives asynchronously, and the flags above already
   * decide the owner's case. A chair will offer a hand it should not; that is a wrong cursor on
   * furniture, not a wrong loot.
   */
  if (unit.gameObject !== null) {
    const { flags, dynamic } = unit.gameObject;
    if ((flags & GO_FLAG_IN_USE_OR_NO_INTERACT) !== 0) {
      return null;
    }
    if ((flags & GO_FLAG_INTERACT_COND) !== 0 && !goIsActivatable(dynamic)) {
      return null;
    }
    return { kind: 'Interact', unable: distanceSq > SERVICE_RANGE_SQ };
  }

  if (unit.dead) {
    if (((unit.fields.dynamicFlags ?? 0) & DYNFLAG_LOOTABLE) !== 0) {
      return { kind: lootCursor(inputs.autoLoot), unable: !inMelee };
    }
    // THE SKIN LEG HAS TWO PRECONDITIONS and the flag is only the first: the reference's
    // `0x482589` also requires the learn-time latch, i.e. the player must have learned a Skinning
    // spell. A non-skinner gets no knife on a skinnable corpse.
    if (((unit.fields.unitFlags ?? 0) & UNIT_FLAG_SKINNABLE) !== 0 && inputs.knowsSkinning) {
      return { kind: 'Skin', unable: !inMelee };
    }
    return null;
  }

  const reaction = reactionFor(unit, self);
  const isPlayer = unit.objectType === OBJECT_TYPE_PLAYER;

  // INTERACTABLE NPC. The reference's own predicate here is interim ("has service flags and is not
  // attack-worthy, reaction >= neutral") because `CGUnit::CanInteract 0x606880` is not fully derived
  // there either; it is carried across unchanged rather than improved on guesswork.
  if (!isPlayer && reaction !== null && reaction >= REACTION_NEUTRAL) {
    const kind = serviceCursor(unit.fields.npcFlags ?? 0, inputs.questgiverHasQuest);
    if (kind !== null) {
      return { kind, unable: distanceSq > SERVICE_RANGE_SQ };
    }
  }

  // ATTACKABLE. `reaction <= neutral` for a creature and `<= hostile` for a peer player -- the same
  // interim matrix the ring's player branch documents, and the same gate
  // `pages/game/index.tsx#onWorldRightClick` already uses to decide whether a right click swings.
  if (reaction !== null
    && ((!isPlayer && reaction <= REACTION_NEUTRAL) || (isPlayer && reaction <= REACTION_HOSTILE))) {
    return { kind: 'Attack', unable: distanceSq > ATTACK_RANGE_SQ };
  }

  return null;
}
