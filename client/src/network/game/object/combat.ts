/**
 * Melee combat and the creature query -- the two wire surfaces a unit frame and a swing need that
 * `SMSG_UPDATE_OBJECT` does not carry.
 *
 * FOUR OPCODES WERE IN `opcode.js` WITH NO SUBSCRIBER ANYWHERE: `SMSG_ATTACKSTART` (0x143),
 * `SMSG_ATTACKSTOP` (0x144), `SMSG_ATTACKERSTATEUPDATE` (0x14A) and
 * `SMSG_CREATURE_QUERY_RESPONSE` (0x061). They were framed, named, emitted and dropped, exactly as
 * `SMSG_DESTROY_OBJECT` was before `update-object/handler.ts` picked it up. That is the whole reason
 * nothing in this client ever swung a weapon: there is no "attack animation" descriptor field --
 * a swing IS a packet, one per weapon-timer cycle.
 *
 * ## Layouts, and where each came from
 *
 * The reference is `samples/benilla/crates/benilla-protocol/src/messages/attack.rs`, which
 * byte-verifies each against vmangos' own builders. WHERE 3.3.5a DIFFERS FROM THE REFERENCE'S 1.12
 * IT IS SAID AT THE READ -- and the claim this header used to make, that only
 * `SMSG_CREATURE_QUERY_RESPONSE` differs and only by an inserted string, WAS WRONG.
 *
 *  - `SMSG_ATTACKSTART`: two FULL `u64` guids, not packed (`attack.rs:16-18`).
 *  - `SMSG_ATTACKSTOP`: two PACKED guids, then a `u32` "victim is dead" (`attack.rs:86-92`). The two
 *    messages disagree about packing and that is not a transcription slip -- vmangos' two builders
 *    genuinely differ. Reading either the other's way desyncs.
 *  - `SMSG_ATTACKERSTATEUPDATE`: `HitInfo u32`, attacker PACKED, victim PACKED, `Damage u32`,
 *    **`OverDamage u32` (WotLK only)**, a sub-damage COUNT byte, that many **12-byte** blocks
 *    (school, float damage, damage), then **separate absorb and resist loops present only when
 *    `HitInfo` carries their bits**, then `VictimState u32`. The reference's 1.12 form -- no
 *    overkill, 20-byte sub-blocks with absorb and resist inline -- was followed here and put every
 *    field after `Damage` at the wrong offset. See `handleAttackerState`, which now validates its own
 *    decode, and `game/classes/combat-wire.ts`, which records what actually arrived.
 *
 * `CMSG_SET_SELECTION` (0x13D) carries a **full 8-byte little-endian guid, not packed** -- vmangos
 * `SetSelection::ReadFromWorldPacket` reads a raw `uint64`
 * (`crates/benilla-protocol/src/world/writer/selection.rs:20-24`). A packed guid here is silently
 * accepted and selects the wrong unit.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GameOpcode from '../opcode';
import GamePacket from '../packet';
import { GUID_BYTES, guidBytes, guidHex } from '../../guid-hex';
import { classificationWord } from '../../../game/ui/framexml/lua/api/units';
import {
  ATTACK_UNARMED, defenseAnimation, isWhiff, swingAnimation,
} from '../../../game/classes/combat-anim';
import { combatWire } from '../../../game/classes/combat-wire';
import {
  HIT_INFO, HIT_INFO_ANY_ABSORB, HIT_INFO_ANY_RESIST,
} from '../../../game/classes/combat-text';
import { worldClock } from '../../../game/pipeline/m2/anim/world-clock';
import { windowElapsedOrInstant } from '../../../game/pipeline/m2/anim/instance-anim';

/**
 * The `HitInfo` bits this decode reads. **THE TABLE MOVED**, and it moved for a reason:
 * `classes/combat-text.ts#HIT_INFO` is now the ONE place 3.3.5a's `HitInfo` is written down, because
 * the combat-text law needs the crit, glancing and crushing bits from the same word and two hand-kept
 * copies of a version-numbered table is how they drift.
 *
 * That file also carries the source line these constants never had. In brief: they are a SERVER
 * implementation (TrinityCore `Unit.h` `enum HitInfo`, 3.3.5 branch) -- no DBC states them and the
 * client's own Lua is handed already-decoded strings -- and the reference is NOT usable here, since its
 * `wound_anim` reads bit `0x80` as CRITICAL (`select.rs:778`) which on 3.3.5a is `HITINFO_FULL_RESIST`.
 *
 * The two presence masks decide whether the trailing per-sub loops are on the wire at all, and the
 * decode VALIDATES its result rather than trusting them -- see `handleAttackerState`.
 */
const HIT_INFO_OFFHAND = HIT_INFO.OFFHAND;
const HIT_INFO_NO_ANIMATION = HIT_INFO.NO_ANIMATION;

/** One creature template's UI-visible head, as far as a unit frame needs it. */
export interface CreatureInfo {
  name: string;
  /** `rank` -- 0 normal, 1 elite, 2 rare-elite, 3 world boss, 4 rare. See `classificationWord`. */
  rank: number;
}

export class CombatHandler extends EventEmitter {
  private game: GameHandler;

  /** entry -> template, once its query has been answered. */
  private creatures = new Map<number, CreatureInfo>();

  /** Entries already asked about, so a grid of eleven identical wolves sends one query. */
  private asked = new Set<number>();

  /**
   * OUR OWN SELECTION, as a normalised guid string or null.
   *
   * Held here rather than on `World` because this is the object that owns the wire half: the setter
   * and `CMSG_SET_SELECTION` must not be able to disagree about what the server thinks we have.
   */
  private selected: string | null = null;

  constructor(gameHandler: GameHandler) {
    super();
    this.game = gameHandler;
    this.game.on('packet:receive:SMSG_CREATURE_QUERY_RESPONSE', this.handleCreatureQuery.bind(this));
    this.game.on('packet:receive:SMSG_ATTACKSTART', this.handleAttackStart.bind(this));
    this.game.on('packet:receive:SMSG_ATTACKSTOP', this.handleAttackStop.bind(this));
    this.game.on('packet:receive:SMSG_ATTACKERSTATEUPDATE', this.handleAttackerState.bind(this));

    // THE FOUR SWING REFUSALS, which were unread and therefore SILENT.
    //
    // THE STORY THAT USED TO BE HERE WAS WRONG, and it is left corrected rather than deleted because it
    // cost three rounds. It said: the server accepts the attack and then refuses every swing, resetting
    // the weapon timer without ending the attack, so the fix is a target-facing law. MEASURED instead
    // (`scratchpad/pj-swing.js` and `pj-fight.js`, :3000): at melee range auto-attack lands SIX swings
    // 2.8 s apart with `swingRefusals` empty, and the failing captures were a REJECTION -- one
    // `SMSG_ATTACKSTOP` naming us and the target, no `SMSG_ATTACKSTART` at all (see `handleAttackStop`).
    // The only refusal ever observed is `NOTINRANGE`, once, from 10.3 and 21.9 yd, and it arrives with
    // `SMSG_ATTACKSTART` and the Ready stance -- i.e. exactly as the opcode's name says.
    //
    // So these handlers are instrumentation that WORKS and had nothing to report, which is a different
    // thing from a mystery. `facing.rs#face_target` was never the fix and could not have been: it
    // excludes the local player by construction (`net/motion/facing.rs:85-88`, `Without<SelfPlayer>`).
    ([
      'SMSG_ATTACKSWING_NOTINRANGE',
      'SMSG_ATTACKSWING_BADFACING',
      'SMSG_ATTACKSWING_DEADTARGET',
      'SMSG_ATTACKSWING_CANT_ATTACK',
    ] as const).forEach((name) => {
      this.game.on(`packet:receive:${name}`, () => this.handleSwingRefused(name));
    });
  }

  // -- Selection ----------------------------------------------------------------------------------

  get selection(): string | null {
    return this.selected;
  }

  /**
   * Tell the server what we have picked, and remember it.
   *
   * Deduped: the real client sends this once per pick, and re-sending the same guid makes the server
   * re-run `HandleSetSelectionOpcode`, which cancels an in-flight cast
   * (`benilla/src/net/apply/spells.rs:109`). `null` clears, which is guid 0 on the wire and is what
   * the reference sends on teardown (`net/apply/objects.rs:367`).
   */
  select(guid: string | null): void {
    const next = guid ?? '0x0';
    if (this.selected === (guid ?? null)) {
      return;
    }
    this.selected = guid ?? null;

    // NO TARGET MEANS NO AUTO-ATTACK -- the owner's "Автоатака должна отменяться если цели нет или она
    // сброшена esc."
    //
    // **THIS IS THE ONE CHOKE POINT, and that is why it is here rather than on a key handler.** Every
    // way of losing a target funnels through `World#setTarget(null)` and therefore through this method:
    // the client's own `ClearTarget()` (`ui/target-bridge.ts`), which is the leg `Esc` reaches through
    // the client's own Lua and its established precedence -- a cast cancels first, then this -- and
    // `World#remove`, which clears the target when the unit dies-and-decays or streams out of range. So
    // "the target is gone" is handled as ONE condition, and no second competing `Esc` handler is added.
    //
    // **ONLY ON A CLEAR, NOT ON A SWITCH.** Selecting a different unit leaves the attack running: the
    // real client re-aims auto-attack at the new target rather than dropping it, and the owner asked
    // about the absence of a target, not about changing one.
    //
    // **THE SERVER IS TOLD, AND THE SERVER IS WHAT CLEARS THE UI.** `CMSG_ATTACKSTOP` (0x142, this
    // client's own 3.3.5a table, empty body) goes out here; the button and the combat pose are NOT
    // touched from this method. They follow from the server's `SMSG_ATTACKSTOP`, which
    // `handleAttackStop` already turns into `emit('autoAttack', false)` -> `SpellHandler#setAutoAttack`
    // for the bar and `inCombat = false` for the stance. Driving them locally would be a second source
    // of truth for a state the server owns, which is the same argument `handleAttackStart` makes for
    // taking the button's checked state from the wire rather than from our own send.
    //
    // That also makes this correct WHETHER OR NOT the server stops the attack by itself on a selection
    // clear: if it does, our stop is redundant and its reply is the same packet; if it does not, ours is
    // what ends it. Either way there is exactly one `SMSG_ATTACKSTOP` path into the UI, so the two
    // cannot disagree -- which is worth more than settling the question, since the answer is a server
    // implementation detail that could differ between the servers this client is pointed at.
    if (this.selected === null && this.attacking) {
      this.stopAttack();
    }

    const app = new GamePacket(GameOpcode.CMSG_SET_SELECTION, 6 + GUID_BYTES);
    // A FULL 8-byte little-endian guid. `guidBytes` is the inverse of the single formatter every
    // guid in this client is normalised by, so what goes out is byte-for-byte what came in.
    const bytes = guidBytes(next);
    for (let i = 0; i < GUID_BYTES; ++i) {
      app.writeUnsignedByte(bytes[i]);
    }
    this.game.send(app);
    this.emit('selection', this.selected);
  }

  /**
   * `CMSG_ATTACKSWING` (0x141): begin melee auto-attack on `guid`. Body is one FULL 8-byte guid
   * (`benilla-protocol/src/messages/attack.rs:104-108`, "vmangos `AttackSwing::ReadFromWorldPacket`").
   *
   * The server answers `SMSG_ATTACKSTART` (echoed to us as well as to observers) or one of the
   * attack-swing error packets -- out of range, bad facing, dead target -- which this client does not
   * read yet. So a swing that never starts is currently silent; that is named in the report.
   */
  startAttack(guid: string): void {
    const app = new GamePacket(GameOpcode.CMSG_ATTACKSWING, 6 + GUID_BYTES);
    const bytes = guidBytes(guid);
    for (let i = 0; i < GUID_BYTES; ++i) {
      app.writeUnsignedByte(bytes[i]);
    }
    this.game.send(app);
  }

  /** `CMSG_ATTACKSTOP` (0x142): stop auto-attacking. EMPTY BODY -- the reference notes it takes none. */
  stopAttack(): void {
    this.game.send(new GamePacket(GameOpcode.CMSG_ATTACKSTOP, 6));
  }

  // -- The creature query -------------------------------------------------------------------------

  /** What we know about a template, or null while its query is outstanding. */
  creatureInfo(entry: number): CreatureInfo | null {
    return this.creatures.get(entry) ?? null;
  }

  /**
   * `CMSG_CREATURE_QUERY`: `u32 entry` then a FULL 8-byte guid
   * (`benilla-protocol/src/messages/client.rs:249-256`).
   *
   * A creature's NAME and its CLASSIFICATION both live here and nowhere else -- there is no
   * `UNIT_FIELD_NAME` and no `UNIT_FIELD_CLASSIFICATION`. So a target frame cannot name a wolf until
   * this round-trips, which is why the query is fired the moment a unit is selected rather than
   * batched.
   */
  queryCreature(entry: number, guid: string): void {
    if (!entry) {
      return;
    }
    // ALREADY ANSWERED: apply it rather than returning, and this is not an optimisation.
    // `asked` and `creatures` outlive a world session (this handler is built once per `GameHandler`),
    // so after a reconnect every unit is a fresh `Unit` with no name while the template is still in
    // the cache -- a bare `asked.has` guard would skip the query AND never write the name, leaving
    // every creature "<unknown>" for the rest of the second session.
    const known = this.creatures.get(entry);
    if (known) {
      this.applyCreatureInfo(entry, known);
      return;
    }
    if (this.asked.has(entry)) {
      return;
    }
    this.asked.add(entry);
    const app = new GamePacket(GameOpcode.CMSG_CREATURE_QUERY, 6 + 4 + GUID_BYTES);
    app.writeUnsignedInt(entry >>> 0);
    const bytes = guidBytes(guid);
    for (let i = 0; i < GUID_BYTES; ++i) {
      app.writeUnsignedByte(bytes[i]);
    }
    this.game.send(app);
  }

  /**
   * `SMSG_CREATURE_QUERY_RESPONSE`.
   *
   * THE 3.3.5a LAYOUT, WHICH IS NOT THE REFERENCE'S. benilla parses 1.12
   * (`messages/parse.rs:741-783`): entry, name, three empty names, subname, then the u32 tail whose
   * FOURTH word is `rank`. Build 12340 inserts an `IconName` cstring between the subname and that
   * tail (`WorldSession::HandleCreatureQueryOpcode` writes `Name x4, SubName, IconName, type_flags,
   * type, family, rank, ...`). Reading the 1.12 order here takes `IconName`'s bytes as `type_flags`
   * and lands `rank` one word early -- which would put a silver dragon border on ordinary wolves.
   * The trailing model ids, health/power modifiers and quest items are not read at all: nothing here
   * needs them and an unread tail cannot desync a packet that is its own frame.
   */
  handleCreatureQuery(gp: GamePacket) {
    const raw = gp.readUnsignedInt() >>> 0;
    // The miss is the entry echoed with its top bit set, and nothing follows it.
    if ((raw & 0x80000000) !== 0) {
      return;
    }
    const entry = raw;
    // `readCStr`, NOT `readCString`, AND THIS WAS A LIVE DEFECT -- byte-buffer's reader does not
    // consume the terminator of an EMPTY string (`net/packet.js#readCStr` carries the measurement).
    // For an ordinary creature FIVE of these six are empty -- the three unused name slots, the
    // subname and the icon name -- so `rank` below was read **five bytes early**, out of the middle
    // of `type_flags`/`type`. `name` is the first string and decodes correctly either way, which is
    // exactly why this survived: the classification was wrong and the name was right.
    const name = gp.readCStr();
    gp.readCStr();
    gp.readCStr();
    gp.readCStr();
    gp.readCStr(); // SubName
    gp.readCStr(); // IconName -- 3.3.5a only; see above
    gp.readUnsignedInt(); // type_flags
    gp.readUnsignedInt(); // type (CreatureType.dbc)
    gp.readUnsignedInt(); // family
    const rank = gp.readUnsignedInt() >>> 0;

    const info = { name, rank };
    this.creatures.set(entry, info);
    this.applyCreatureInfo(entry, info);
  }

  /**
   * Write a template's name and classification onto every unit that shares it.
   *
   * PER TEMPLATE, not per unit: one query answers for all eleven wolves in a camp, not only for the
   * one that provoked it. Announced through the same `unit:fields` event the descriptor path uses, so
   * the UI bridge's diff decides whether anything is actually re-drawn.
   */
  private applyCreatureInfo(entry: number, info: CreatureInfo): void {
    const classification = classificationWord(info.rank);
    for (const unit of this.game.world.entities.values()) {
      if (unit.fields.entry === entry && (unit.name !== info.name || unit.classification !== classification)) {
        unit.name = info.name;
        unit.classification = classification;
        this.game.world.emit('unit:fields', unit);
      }
    }
  }

  // -- The swing ----------------------------------------------------------------------------------

  /**
   * `SMSG_ATTACKSTART`: two FULL u64 guids (`attack.rs:16-18`).
   *
   * The EDGE, not the swing. It says "this unit has entered melee auto-attack", which in the real
   * client raises the ready pose; the actual per-cycle swing is `SMSG_ATTACKERSTATEUPDATE`. It is
   * recorded on the unit and announced, and deliberately arms NO animation: arming a swing here and
   * again on the first state update would double the first swing.
   */
  handleAttackStart(gp: GamePacket) {
    const attacker = this.readFullGuid(gp);
    const victim = this.readFullGuid(gp);
    const unit = this.game.world.entities.get(attacker);
    if (unit) {
      unit.inCombat = true;
      unit.combatTarget = victim;
    }
    // BOTH ENDS OF THE BRACKET. The victim is in this fight too, and until now nothing said so: a
    // player being bitten who had not swung was never marked engaged and stood in the out-of-combat
    // idle for the whole fight (measured -- see `Unit#attackedBy`, which also records why the unit flag
    // words are not the route and where this deviates from the reference). Either party may be a peer,
    // hence the same plain `entities` lookup the defense reaction uses.
    const victimUnit = this.game.world.entities.get(victim);
    if (victimUnit) {
      victimUnit.attackedBy.add(attacker);
    }
    // OUR OWN auto-attack going on, for the action button that holds spell 6603 "Auto Attack". Emitted
    // from the SERVER's packet rather than from our `CMSG_ATTACKSWING` send, because a swing request the
    // server refuses must leave the button un-checked -- and `handleAttackStop` below documents that a
    // refusal is exactly what a rejected swing looks like here. `ObjectHandler` forwards this to
    // `SpellHandler#setAutoAttack`.
    if (attacker === this.game.world.player?.guid) {
      this.attacking = true;
      this.emit('autoAttack', true);
    }
    this.emit('attack:start', attacker, victim);
  }

  /**
   * `SMSG_ATTACKSTOP`: two PACKED guids and a `u32` dead flag (`attack.rs:86-92`).
   *
   * THE VICTIM IS READ AND CARRIED, and that is this round's whole diagnosis. Three rounds took
   * "auto-attack does not work" to be the server REFUSING each swing (bad facing, out of range) and
   * built a follow-up around porting a target-facing law. Measured on the wire instead
   * (`scratchpad/pj-swing.js`, one account, a Northshire wolf), the reply to our `CMSG_ATTACKSWING`
   * is this packet and nothing else:
   *
   *   03 a6 59 | db 73 26 2b 01 30 f1 | 00 00 00 00
   *   attacker = 0x59a6 (ourselves)     victim = 0xf13000012b002673 (the wolf)    dead = 0
   *
   * and NONE of the four `SMSG_ATTACKSWING_*` refusals ever arrived (`swingRefusals` stayed `{}`).
   * The attack never STARTED. A server has two arms that answer a swing request this way and they
   * differ only in this field -- an unresolved guid answers with victim 0 (`SendAttackStop(NULL)`),
   * an invalid target answers with the victim named -- so throwing the victim away, which this method
   * used to do, made the two indistinguishable and made "the attack was rejected outright" look like
   * "the attack started and then every swing was refused". The victim is named here so the next round
   * starts from bytes.
   */
  handleAttackStop(gp: GamePacket) {
    const attacker = gp.readPackedGUID();
    const victim = gp.readPackedGUID();
    const unit = this.game.world.entities.get(attacker);
    if (unit) {
      unit.inCombat = false;
      unit.combatTarget = null;
    }
    // The victim's end of the bracket. Keyed by ATTACKER guid, so a unit fighting three wolves keeps
    // its guard until the last of the three stops. A victim guid of 0 (`SendAttackStop(NULL)`) resolves
    // to no unit and clears nothing, which is right: that reply is about a guid the server could not
    // find, not about a fight ending.
    const stoppedVictim = this.game.world.entities.get(victim);
    if (stoppedVictim) {
      stoppedVictim.attackedBy.delete(attacker);
    }
    // OUR OWN attack being stopped with a victim named, when we never had a swing land, is a
    // REJECTION and not the end of a fight. Said once per victim so a real disengage is quiet.
    if (attacker === this.game.world.player?.guid && victim !== '0x0'
      && !this.warnedRejection.has(victim)) {
      this.warnedRejection.add(victim);
      console.warn(
        `combat: the server answered our CMSG_ATTACKSWING at ${victim} with SMSG_ATTACKSTOP --`
        + ' the attack was rejected outright rather than started, and NO SMSG_ATTACKSWING_* refusal'
        + ' arrived. A named victim means the guid resolved and the target was judged invalid'
        + ' (dead attacker, dead or unattackable target); victim 0x0 would mean the guid did not'
        + ' resolve. Read window.combatWire.history() and swingRefusals.',
      );
    }
    // Our auto-attack is off -- whether this is a real disengage or the outright rejection warned about
    // just above. Both leave us not swinging, so both un-check the button.
    if (attacker === this.game.world.player?.guid) {
      this.attacking = false;
      this.emit('autoAttack', false);
    }
    this.emit('attack:stop', attacker, victim);
  }

  /** One warning per victim -- see `handleAttackStop`. */
  private warnedRejection = new Set<string>();

  /**
   * Are WE auto-attacking right now?
   *
   * Driven from the SERVER's `SMSG_ATTACKSTART`/`SMSG_ATTACKSTOP`, not from our own `CMSG_ATTACKSWING`
   * send -- the same rule the action button's checked state follows, and for the same reason: a swing
   * request the server refuses must not leave us believing we are attacking. `handleAttackStop`
   * documents that an outright rejection arrives as exactly that packet.
   *
   * Read only by `select`, to decide whether losing the target has an attack to cancel. Without it a
   * plain deselect would send `CMSG_ATTACKSTOP` on every click on empty ground.
   */
  private attacking = false;

  /**
   * `SMSG_ATTACKERSTATEUPDATE` -- ONE COMPLETED SWING, and the animation driver.
   *
   * benilla's decision 0073: the packet is emitted exactly once per weapon-timer cycle, per hand, and
   * the real client plays one attacker swing animation per packet. So the arm is unconditional (bar
   * the suppress bit) rather than rate-limited -- the wire already carries the cadence.
   *
   * The sub-damage loop is READ, not skipped. Its count byte is followed by that many 20-byte blocks
   * and the fields this method actually wants (`TargetState`, `BlockedAmount`) sit AFTER them, so a
   * fixed skip would read `TargetState` out of the middle of a damage block on any hit with more than
   * one school.
   */
  handleAttackerState(gp: GamePacket) {
    const bodySize = gp.bodySize;
    const hitInfo = gp.readUnsignedInt() >>> 0;
    const attacker = gp.readPackedGUID();
    const victim = gp.readPackedGUID();
    const damage = gp.readUnsignedInt() >>> 0;

    // THE 3.3.5a LAYOUT, and the two places it is NOT the 1.12 one this decode was written from.
    //
    // The previous version followed `attack.rs:55-83`, which is the reference's 1.12.1 structure, and
    // CLAUDE.md's rule is that version-numbered values come from the game's own data. Two differences,
    // and both shift everything after `Damage`:
    //
    //  1. WotLK inserts `OverDamage` (overkill) between the damage total and the sub-damage count. The
    //     old decode read the count out of the middle of that field.
    //  2. Absorb and resist are NOT per-sub fields inside the loop. They are separate trailing loops,
    //     each present only when `HitInfo` carries its bits. The old decode read two unconditional u32
    //     per sub, so on the common no-absorb no-resist swing it over-read eight bytes per sub on top
    //     of the four it was already out by.
    //
    // Neither broke the swing animation, because `hitInfo` and `attacker` are read BEFORE all of it --
    // which is exactly why this could sit here unnoticed while the swing looked fine.
    const overkill = gp.readUnsignedInt() >>> 0;
    const subs = gp.readUnsignedByte();
    // THE FIRST SUB-BLOCK'S `SchoolMask` IS NOW KEPT, and it is the one field the display needs out of
    // this loop: the client's own `CombatFeedback_OnCombatEvent` prints a non-physical wound YELLOW
    // (`combatfeedback.lua:50-54`), and its `type` argument is exactly this word. FIRST rather than
    // OR-folded across the subs, because the client's test is `type ~= SCHOOL_MASK_PHYSICAL` -- a single
    // value, not a mask to be reduced -- and a melee swing carries one school in practice. A multi-school
    // swing's later schools are dropped, which is stated rather than folded into a value the client's own
    // comparison would then read as neither physical nor any one school.
    let school = 0;
    for (let i = 0; i < subs; ++i) {
      const mask = gp.readUnsignedInt() >>> 0; // SchoolMask
      if (i === 0) {
        school = mask;
      }
      gp.readFloat();       // FDamage
      gp.readUnsignedInt(); // Damage
    }
    if ((hitInfo & HIT_INFO_ANY_ABSORB) !== 0) {
      for (let i = 0; i < subs; ++i) { gp.readUnsignedInt(); }
    }
    if ((hitInfo & HIT_INFO_ANY_RESIST) !== 0) {
      for (let i = 0; i < subs; ++i) { gp.readUnsignedInt(); }
    }

    // VALIDATED, NOT TRUSTED. The layout above is derived rather than sniffed, so it checks itself
    // before anything acts on it: the word has to be there, and it has to be a `VictimState` the
    // reference's own two independent tables recognise. A decode that does not add up arms NOTHING --
    // the swing still plays, because it was read before the disputed region -- and says so once.
    // Silently playing a dodge because a byte offset slipped is the failure this guards.
    let victimState: number | null = null;
    if (gp.index + 4 <= gp.length) {
      const raw = gp.readUnsignedInt() >>> 0;
      victimState = raw <= 8 ? raw : null;
      if (victimState === null) {
        this.warnBadVictimState(hitInfo, raw, bodySize, subs);
      }
    } else {
      this.warnBadVictimState(hitInfo, -1, bodySize, subs);
    }

    combatWire.record({
      at: performance.now(),
      hitInfo,
      attacker,
      victim,
      damage,
      overkill,
      subs,
      school,
      victimState,
      bodySize,
      consumed: gp.index - gp.headerSize,
    });

    // THE OUTCOME TRAVELS WITH THE SWING, and it did not until now: this emit carried `damage` alone
    // while `hitInfo` and `victimState` -- both decoded and both VALIDATED one statement above -- were
    // dropped on the floor. So a crit, a miss, a dodge and a parry were all indistinguishable to every
    // subscriber, which is why no combat text could be honest. `school` likewise.
    //
    // Emitted RAW rather than pre-interpreted: the display law is
    // `game/classes/combat-text.ts#meleeText`, shared by the floating world text and the client's own
    // `CombatFeedback`, and a handler that reads the word straight off the wire is a handler that cannot
    // have made a different decision from the other medium.
    this.emit('attack:swing', attacker, victim, damage, hitInfo, victimState, school);

    if ((hitInfo & HIT_INFO_NO_ANIMATION) !== 0) {
      return;
    }

    const unit = this.game.world.entities.get(attacker);
    if (unit) {
      const offhand = (hitInfo & HIT_INFO_OFFHAND) !== 0;
      const swingId = swingAnimation(unit, offhand) ?? ATTACK_UNARMED;

      // THE SWING PLAYS AT ITS AUTHORED RATE, AND THE TIMER GOVERNS THE NEXT ONE -- not this one's
      // pace. The previous commit had it backwards: it stretched the clip to fill
      // `UNIT_FIELD_BASEATTACKTIME`, so `seq 19` ran at 0.46x for the whole 2.9 s and the owner reported
      // "атакует очень медленно, на протяжении всего свинг тайма, однако атака должна происходить
      // быстрее чем свинг тайм, но после атаки происходит ожидание завершения свинга". So the swing is a
      // fast one-shot and the Ready idle fills the remainder of the timer, which the ownership latch
      // already does for free: `startAnimation` latches `externalSeq`, `updateLocomotion` releases it
      // when the window elapses, and the engaged cascade's next pick is the Ready rung.
      //
      // Nothing writes a rate on the normal path any more. `setAnimation` -> `startAnimation` -> `arm`
      // starts every swing at 1x, which is what the reference does too: it scales gaits by ground speed
      // (`select.rs:1053-1056`) and NEVER scales a combat one-shot by the weapon timer.
      //
      // THE ONE CASE WHERE THE TIMER IS SHORTER THAN THE CLIP has a byte-verified answer in the
      // reference, and it is not a computed compression: the COMBAT FAST-PATH
      // (`creature_anim/driver.rs:864-872`, the client's `0x5fe43c`-`0x5fe48b`, wow-re
      // `combat-anim-fastpath.md`, decision 0406) -- "a combat clip requested while another combat clip
      // is playing is NOT armed: the CURRENT clip's rate doubles (op6 2.0f re-times its remainder,
      // pose-continuous) and the request parks in the `+0xd60` cache to play afterwards ... consecutive
      // swings don't hard-cut each other". A flat 2x, not `clip / timer`.
      //
      // The DOUBLING is ported here. The PARK is not: the deferred cache needs a drain point in the
      // locomotion release and a swing dropped this way is a swing not drawn, so it is named rather
      // than faked. Reachable only with haste on an already-fast weapon (the shortest authored swing
      // clips are ~1000 ms and the fastest weapon timer is 1300), which is why it is not urgent.
      //
      // This also replaces `interrupt: true`, which was a HARD CUT of the in-flight swing -- the exact
      // thing the reference says the fast-path exists to prevent.
      const live = unit.model?.instanceAnim ?? null;
      const inFlight = live && live.current && live.current.id === swingId
        && !windowElapsedOrInstant(live, live.current, worldClock.ms);
      if (inFlight && live) {
        live.setRate(2, worldClock.ms);
      } else {
        // Repetitions 0 -- a swing is a ONE-SHOT, and `startAnimation`'s ownership latch gives the body
        // back to locomotion when its window ends.
        unit.setAnimation(swingId, true, 0);
      }

      // ONLY WHEN THE ARM ACTUALLY LANDED ON THE SWING, and this guard was the defect a self-review of
      // the previous commit found. `setAnimation` goes through `resolve`, which falls back to the first
      // inline sequence -- normally the looping Stand -- for any id the model does not own, and it also
      // returns early leaving whatever was playing in place. Without `armed.id === swingId`, a creature
      // with no swing clip (a wolf owns only `AttackUnarmed 16`; nothing owns all eight) would have had
      // a rate written onto its RUNNING GAIT LOOP -- and `updateLocomotion`'s "never re-arm a running
      // loop" guard means that rate would then persist for the rest of that unit's life. Exactly the
      // class of bug the `setScalar`-under-`matrixAutoUpdate` and hover-magnitude traps are.
      const inst = unit.model?.instanceAnim ?? null;
      const armed = inst?.current?.id === swingId ? inst.current : null;

      // THE WHIFF SLOW-DOWN (`impact.rs:73-76`, the client's `0x712910`, decision 0279): a swing that
      // contacted nothing -- miss, dodge, evade -- runs the rest of its arc at half speed. That IS what
      // a missed swing looks like; there is no victim clip for a miss, so this is the whole of it. A
      // parry or a block still contacts, so neither slows.
      //
      // After the arm AND after the swing-time scaling above, and MULTIPLICATIVE on it: half of the
      // weapon's own pace, not a flat 0.5x that would make a claymore's whiff faster than its hit.
      // Through `setRate`, which re-anchors the clock and therefore does not jump the pose.
      // `armed`, not `inst` alone -- the same guard, and the whiff needed it too: this line predates
      // this round and would slow a gait loop to half speed for ever on any unit whose model has no
      // swing clip. A miss on a clipless attacker now slows nothing, which is the honest answer.
      if (victimState !== null && isWhiff(victimState) && inst && armed) {
        inst.setRate(inst.playbackRate * 0.5, worldClock.ms);
      }
    }

    // THE VICTIM'S REACTION, on the VICTIM and not the attacker -- and either may be a peer, which is
    // why this is a plain `entities` lookup on the same remote path the stance and the gait live on.
    // Dodge, block and parry each have a clip; a miss and an evade have none (see `defenseAnimation`).
    // A corpse reacts to nothing: the client gates the `$CPP` dispatch on the victim being alive.
    //
    // A ONE-SHOT over whatever the victim is holding, exactly like the swing, so `setAnimation`'s
    // ownership latch gives the body back when its window ends -- which for an engaged victim is back to
    // the Ready stance.
    //
    // KNOWN DEVIATION, stated: the reference plays this on a MASKED overlay at 0.75 weight with a decay
    // envelope (`WOUND_AMPLITUDE`, `wound_full_body`), so the victim's legs keep walking. This client has
    // one track, so it plays FULL BODY. The reference's own rule is that the full-body case is precisely
    // a victim whose base pose is a combat-ready stance {25..29} -- which, now that an engaged unit
    // holds a Ready idle, is the common combat case -- so the approximation is right where it matters and
    // wrong for a victim who is walking. The masked version needs the second weighted track that
    // `blendTime` and the weapon grip are also waiting on.
    if (victimState !== null) {
      const victimUnit = this.game.world.entities.get(victim);
      if (victimUnit && !victimUnit.dead) {
        const reaction = defenseAnimation(victimState, victimUnit);
        // ONLY IF THE MODEL OWNS IT -- `resolve(id, false)` withholds the Stand consolation precisely so
        // "absent" is distinguishable from "present", and that distinction is load-bearing here.
        //
        // MEASURED, and it is why this guard exists: a wolf's own table (`creature/wolf/wolf.m2`, 39
        // sequences, cross-read against `AnimationData.dbc`) has NO Dodge 30, no ShieldBlock 24 and no
        // Parry 20-23. Arming one anyway would have gone through `resolve`'s fallback to the first
        // inline sequence -- Stand -- with `interrupt` true, so a dodging wolf would have SNAPPED out of
        // its bite into a one-frame Stand and back. `startAnimation` would not even latch it (the arm
        // did not land on the requested id), so the cascade would re-arm the next frame: a flicker, not
        // a reaction. Creatures dodge with no clip at all, which is the honest answer for a model that
        // has none.
        const modelAnim = victimUnit.model?.modelAnim ?? null;
        if (reaction !== null && modelAnim && modelAnim.resolve(reaction, false) !== null) {
          victimUnit.setAnimation(reaction, true, 0);
        }
      }
    }
  }

  /**
   * How many times each swing refusal has arrived, and the last one seen.
   *
   * Counted rather than only logged, because the useful reading is a RATIO: one `BADFACING` while you
   * turn is normal, and two hundred of them with zero swings landing is the defect. Readable as
   * `window.session.protocol.game.objectHandler.combatHandler.swingRefusals`.
   */
  public swingRefusals: Record<string, number> = {};

  private handleSwingRefused(name: string): void {
    this.swingRefusals[name] = (this.swingRefusals[name] ?? 0) + 1;
    // Once per opcode. The server repeats these at the weapon-timer rate for as long as the condition
    // holds, so an unthrottled log is a flood, and the count above carries the rate anyway.
    if (this.swingRefusals[name] === 1) {
      console.warn(
        `combat: the server REFUSED our melee swing -- ${name}. Auto-attack stays on and no swing`
        + ' lands, so this looks exactly like "auto-attack is broken". Nothing in this client turns'
        + ' the character toward its auto-attack target; see the constructor.',
      );
    }
    this.emit('attack:refused', name, this.swingRefusals[name]);
  }

  /** Once per distinct shape, so a mis-decode is loud but not a per-swing flood. */
  private warnedVictimState = new Set<string>();

  private warnBadVictimState(
    hitInfo: number, raw: number, bodySize: number, subs: number,
  ): void {
    const key = `${hitInfo}:${subs}:${bodySize}`;
    if (this.warnedVictimState.has(key)) {
      return;
    }
    this.warnedVictimState.add(key);
    console.warn(
      'combat: SMSG_ATTACKERSTATEUPDATE did not decode to a VictimState -- hitInfo 0x'
      + `${hitInfo.toString(16)}, subs ${subs}, body ${bodySize} bytes, read ${raw}.`
      + ' The swing still plays; no defense reaction was armed. Read window.combatWire.history().',
    );
  }

  /** Eight little-endian bytes -> the normalised guid string. See `guid-hex.ts` for why not a Number. */
  private readFullGuid(gp: GamePacket): string {
    const bytes = new Uint8Array(GUID_BYTES);
    for (let i = 0; i < GUID_BYTES; ++i) {
      bytes[i] = gp.readUnsignedByte();
    }
    return guidHex(bytes);
  }
}
