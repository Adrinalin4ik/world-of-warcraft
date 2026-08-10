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
 * IT IS SAID AT THE READ -- only `SMSG_CREATURE_QUERY_RESPONSE` actually does, and only by one
 * inserted string.
 *
 *  - `SMSG_ATTACKSTART`: two FULL `u64` guids, not packed (`attack.rs:16-18`).
 *  - `SMSG_ATTACKSTOP`: two PACKED guids, then a `u32` "victim is dead" (`attack.rs:86-92`). The two
 *    messages disagree about packing and that is not a transcription slip -- vmangos' two builders
 *    genuinely differ. Reading either the other's way desyncs.
 *  - `SMSG_ATTACKERSTATEUPDATE`: `HitInfo u32`, attacker PACKED, victim PACKED, `TotalDamage u32`,
 *    a sub-damage COUNT byte and that many 20-byte blocks, `TargetState u32`, two `u32`s, then
 *    `BlockedAmount` (`attack.rs:55-83`). The sub-damage loop is the part that cannot be skipped by
 *    a fixed offset.
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
import { swingAnimation, ATTACK_UNARMED } from '../../../game/classes/combat-anim';

/**
 * `HitInfo` bit `0x4` marks an OFFHAND swing and `0x10000` suppresses the animation entirely
 * (`attack.rs:20-27`). Both are read; nothing else in the word is.
 */
const HIT_INFO_OFFHAND = 0x4;
const HIT_INFO_NO_ANIMATION = 0x10000;

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
    const name = gp.readCString();
    gp.readCString();
    gp.readCString();
    gp.readCString();
    gp.readCString(); // SubName
    gp.readCString(); // IconName -- 3.3.5a only; see above
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
    this.emit('attack:start', attacker, victim);
  }

  /** `SMSG_ATTACKSTOP`: two PACKED guids and a `u32` dead flag (`attack.rs:86-92`). */
  handleAttackStop(gp: GamePacket) {
    const attacker = gp.readPackedGUID();
    gp.readPackedGUID();
    const unit = this.game.world.entities.get(attacker);
    if (unit) {
      unit.inCombat = false;
      unit.combatTarget = null;
    }
    this.emit('attack:stop', attacker);
  }

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
    const hitInfo = gp.readUnsignedInt() >>> 0;
    const attacker = gp.readPackedGUID();
    const victim = gp.readPackedGUID();
    const damage = gp.readUnsignedInt() >>> 0;
    const subs = gp.readUnsignedByte();
    for (let i = 0; i < subs; ++i) {
      gp.readUnsignedInt(); // school
      gp.readFloat();       // damage as float
      gp.readUnsignedInt(); // damage
      gp.readUnsignedInt(); // absorb
      gp.readUnsignedInt(); // resist
    }

    this.emit('attack:swing', attacker, victim, damage);

    if ((hitInfo & HIT_INFO_NO_ANIMATION) !== 0) {
      return;
    }
    const unit = this.game.world.entities.get(attacker);
    if (!unit) {
      return;
    }
    const offhand = (hitInfo & HIT_INFO_OFFHAND) !== 0;
    // `interrupt` true: a swing must restart even if the previous swing's window has not elapsed,
    // which at a fast weapon speed it often has not. Repetitions 0 -- a swing is a ONE-SHOT, and
    // `startAnimation`'s ownership latch gives the body back to locomotion when its window ends.
    unit.setAnimation(swingAnimation(unit, offhand) ?? ATTACK_UNARMED, true, 0);
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
