/**
 * THE COMBAT LOG WIRE -- "what a SPELL just did to whom", which is the half of combat this client has
 * never decoded.
 *
 * The owner: "От способностей урон не показывается, только от автоатак. Также не видно урона по себе
 * и не видно событий типа dodge." That is not a display defect. Before this file the ONLY combat-log
 * packet decoded anywhere in `network/` was `SMSG_ATTACKERSTATEUPDATE` (0x14A) -- one melee swing --
 * so a spell could not produce a number, a resisted bolt could not produce a word, and a DoT tick was
 * not observable at all. The five opcodes below were all present in `opcode.js`, NAMED, framed, emitted
 * and dropped with no subscriber -- exactly the state `SMSG_ATTACKSTART`/`STOP`/`ATTACKERSTATEUPDATE`
 * were in before `combat.ts` picked them up, and exactly the state `SMSG_DESTROY_OBJECT` was in before
 * that.
 *
 * Split out of `combat.ts` rather than added to it, which is the same split the reference makes and for
 * the same reason (`benilla-protocol/src/messages/combat_log.rs:1-13`, decision 0640): a *swing*
 * reports itself on the attack wire, a *spell* reports itself here. `combat.ts` is 637 lines of melee
 * and the creature query already.
 *
 * ## WHERE THESE LAYOUTS COME FROM, stated plainly
 *
 * **The opcode NUMBERS are this client's own 3.3.5a table** (`network/game/opcode.js`), which is build
 * 12340's: `SMSG_SPELLHEALLOG` 0x150, `SMSG_SPELLENERGIZELOG` 0x151, `SMSG_SPELLLOGMISS` 0x24B,
 * `SMSG_PERIODICAURALOG` 0x24E, `SMSG_SPELLNONMELEEDAMAGELOG` 0x250. They are NOT taken from the
 * reference, whose 1.12 numbering is different.
 *
 * **The field LAYOUTS are a SERVER IMPLEMENTATION** -- TrinityCore's 3.3.5 branch
 * (`Unit::SendSpellNonMeleeDamageLog`, `Unit::SendPeriodicAuraLog`, `Unit::SendHealSpellLog`,
 * `Unit::SendEnergizeSpellLog`, `Spell::SendLogExecute`'s miss list). This is the SAME CLASS OF SOURCE
 * as the `HitInfo` bits, the NPC service flags and `CMSG_SET_ACTION_BUTTON`'s `u8` slot prefix, all of
 * which are labelled this way in this codebase, and it is labelled here for the same reason: **nothing
 * in the game's own data states a packet body.** No DBC carries one, and the client's own Lua is handed
 * already-decoded values, so FrameXML cannot corroborate a byte offset.
 *
 * The reference is used for STRUCTURE and is explicitly NOT followed on the numbered values
 * (`combat_log.rs:36-63` is the 1.12 body). **WotLK differs from 1.12 in four places, and every one of
 * them is an INSERTION that lands each later field a word out** -- which is the precise failure this
 * project has already been bitten by twice on the melee twin, where 3.3.5a's inserted `OverDamage` put
 * every field after `Damage` at the wrong offset while the packet still looked like it worked:
 *
 *   1. `SMSG_SPELLNONMELEEDAMAGELOG` inserts `overkill u32` after `damage`.
 *   2. `SMSG_PERIODICAURALOG`'s DAMAGE arm inserts `overDamage u32` after the amount and appends a
 *      trailing `critical u8` -- 1.12 has neither, and its absence is why the reference's own
 *      `spell_text` caller hardcodes `crit: false` for periodic ticks. 3.3.5a crits its DoTs.
 *   3. `SMSG_PERIODICAURALOG`'s HEAL arm inserts `overHeal u32` and `absorb u32` and appends
 *      `critical u8`.
 *   4. `SMSG_SPELLHEALLOG` inserts `overHeal u32` and `absorb u32` before the crit byte and appends a
 *      trailing unused byte.
 *
 * ## THE LAYOUTS ARE VALIDATED, NOT TRUSTED
 *
 * Because the source is a server implementation, every decode here reports `consumed` against
 * `bodySize` into `classes/combat-wire.ts#combatLogWire`, and `census()` groups the RESIDUAL per
 * opcode. A correct layout consumes each body to ONE repeated residual; a wrong one scatters, and a
 * loop read at the wrong stride produces a residual that grows with the packet. That ring is the only
 * oracle these layouts have and it is the same instrument `handleAttackerState` already validates
 * itself with. A decode whose residual is negative -- it ran off the end -- announces NOTHING and says
 * so once, because a plausible number invented out of a misaligned read is the exact failure mode this
 * project keeps deleting.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GameOpcode from '../opcode';
import GamePacket from '../packet';
import { GUID_BYTES, guidHex } from '../../guid-hex';
import { combatLogWire } from '../../../game/classes/combat-wire';
import { SPELL_HIT_TYPE_CRIT } from '../../../game/classes/combat-text';

/**
 * The `AuraType` values `SMSG_PERIODICAURALOG` switches its payload on. SOURCE: the same server
 * implementation, `SpellAuraDefines.h` -- and the reference carries the identical set with the
 * identical numbers (`combat_log.rs:99-105`), which is the one corroboration available: aura type ids
 * are DBC-facing (`Spell.dbc`'s effect-aura columns hold them) and did not renumber between the two
 * builds.
 */
const AURA_PERIODIC_DAMAGE = 3;
const AURA_PERIODIC_HEAL = 8;
const AURA_OBS_MOD_HEALTH = 20;
const AURA_OBS_MOD_POWER = 21;
const AURA_PERIODIC_ENERGIZE = 24;
const AURA_PERIODIC_MANA_LEECH = 64;
const AURA_PERIODIC_DAMAGE_PERCENT = 89;

/** One periodic tick, already reduced to what either display medium can ask about. */
export interface PeriodicTick {
  kind: 'damage' | 'heal' | 'energize' | 'leech';
  amount: number;
  school: number;
  absorb: number;
  resist: number;
  crit: boolean;
  /** The `Powers` id for an energize/leech tick, else 0. */
  power: number;
}

/** What a spell landing announces. One shape for the direct log and for each periodic tick. */
export interface SpellDamageEvent {
  target: string;
  caster: string;
  spellId: number;
  amount: number;
  /** `SchoolMask`. The direct log carries a `u8`; the periodic log carries a `u32`. */
  school: number;
  absorb: number;
  resist: number;
  crit: boolean;
  /** True for a DoT tick -- the direct log's own `periodicLog` byte, or a periodic packet. */
  periodic: boolean;
}

export class CombatLogHandler extends EventEmitter {
  private game: GameHandler;

  constructor(gameHandler: GameHandler) {
    super();
    this.game = gameHandler;
    this.game.on('packet:receive:SMSG_SPELLNONMELEEDAMAGELOG', this.handleSpellDamage.bind(this));
    this.game.on('packet:receive:SMSG_PERIODICAURALOG', this.handlePeriodicAura.bind(this));
    this.game.on('packet:receive:SMSG_SPELLHEALLOG', this.handleSpellHeal.bind(this));
    this.game.on('packet:receive:SMSG_SPELLENERGIZELOG', this.handleSpellEnergize.bind(this));
    this.game.on('packet:receive:SMSG_SPELLLOGMISS', this.handleSpellLogMiss.bind(this));
  }

  /**
   * `SMSG_SPELLNONMELEEDAMAGELOG` (**0x250**) -- a spell landing damage. THE packet the owner's first
   * complaint is about.
   *
   * 3.3.5a body: target PACKED · caster PACKED · `spellId u32` · `damage u32` · **`overkill u32`** ·
   * `school u8` · `absorb u32` · `resist i32` · `periodicLog u8` · `unused u8` · `blocked u32` ·
   * `hitInfo u32` · `extendedData u8`.
   *
   * The `overkill` word is the WotLK insertion; the 1.12 form the reference parses
   * (`combat_log.rs:36-63`) has no such field and would read the school byte out of the middle of it,
   * putting absorb, resist and the crit-bearing `hitInfo` all one word out. `school` is a **`u8` here
   * and a `u32` in the periodic log** -- that asymmetry is the server's, not a transcription slip, and
   * reading either as the other desyncs.
   *
   * `resist` is SIGNED. Read unsigned it would make a negative resist (an over-mitigation correction)
   * into ~4.29 billion and take `spellText`'s zero-damage arm straight to "Resist" -- the same class of
   * defect `SpellDuration.dbc`'s row 21 produced when its `baseDuration` was read unsigned.
   */
  private handleSpellDamage(gp: GamePacket): void {
    const bodySize = gp.bodySize;
    const target = gp.readPackedGUID();
    const caster = gp.readPackedGUID();
    const spellId = gp.readUnsignedInt() >>> 0;
    const amount = gp.readUnsignedInt() >>> 0;
    gp.readUnsignedInt(); // overkill -- WotLK only; see above
    const school = gp.readUnsignedByte();
    const absorb = gp.readUnsignedInt() >>> 0;
    const resist = gp.readInt();
    const periodic = gp.readUnsignedByte() !== 0;
    gp.readUnsignedByte(); // unused
    gp.readUnsignedInt(); // blocked -- no consumer; `spellText` never annotates a partial
    const hitInfo = gp.readUnsignedInt() >>> 0;
    const crit = (hitInfo & SPELL_HIT_TYPE_CRIT) !== 0;
    // The trailing `extendedData` flag. READ AND DROPPED rather than left unread, because it is the
    // last field and reading it makes the body close to a residual of EXACTLY ZERO -- which turns the
    // validator from "did not overrun" into "consumed the whole packet", a far stronger statement about
    // a layout whose only source is a server implementation. The reference reads and drops it too
    // (`combat_log.rs:51`). When it is non-zero a float block follows that nothing here needs; that
    // would show up as a positive residual in the census rather than as a wrong number.
    gp.readUnsignedByte();

    if (!this.validate('SMSG_SPELLNONMELEEDAMAGELOG', gp, bodySize)) {
      return;
    }
    combatLogWire.record({
      at: performance.now(),
      opcode: 'SMSG_SPELLNONMELEEDAMAGELOG',
      target,
      caster,
      spellId,
      amount,
      school,
      absorb,
      resist,
      crit,
      missCode: null,
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    this.emit('spell:damage', {
      target, caster, spellId, amount, school, absorb, resist, crit, periodic,
    } as SpellDamageEvent);
  }

  /**
   * `SMSG_PERIODICAURALOG` (**0x24E**) -- one or more DoT/HoT/regen ticks.
   *
   * 3.3.5a body: target PACKED · caster PACKED · `spellId u32` · `count u32` · `count` entries of
   * `{ auraType u32, payload }`. The payload shape depends on the aura type -- see `readPeriodicTick`.
   *
   * **AN UNKNOWN AURA TYPE ABORTS THE WHOLE PACKET rather than skipping the tick.** The entries are
   * variable-length, so a type whose payload width is unknown makes every following entry
   * unreadable; guessing a width would emit invented numbers for the rest of the loop. The residual
   * check would catch it after the fact, but refusing at the point of ignorance is the honest answer
   * and it is what the reference does too (`combat_log.rs:137-143` errors on the same condition).
   */
  private handlePeriodicAura(gp: GamePacket): void {
    const bodySize = gp.bodySize;
    const target = gp.readPackedGUID();
    const caster = gp.readPackedGUID();
    const spellId = gp.readUnsignedInt() >>> 0;
    const count = gp.readUnsignedInt() >>> 0;

    const ticks: PeriodicTick[] = [];
    for (let i = 0; i < count; ++i) {
      // The body is its own frame, so a count read out of a misaligned offset could be enormous. The
      // bound is the remaining body, not a chosen constant: no tick payload is under 4 bytes.
      if (gp.index + 8 > gp.length) {
        this.warnOnce('SMSG_PERIODICAURALOG', `count ${count} runs past the body (${bodySize} B)`);
        return;
      }
      const auraType = gp.readUnsignedInt() >>> 0;
      const tick = this.readPeriodicTick(gp, auraType);
      if (tick === null) {
        this.warnOnce('SMSG_PERIODICAURALOG', `unknown AuraType ${auraType}; the rest of the packet is unreadable`);
        return;
      }
      ticks.push(tick);
    }

    if (!this.validate('SMSG_PERIODICAURALOG', gp, bodySize)) {
      return;
    }
    for (const tick of ticks) {
      combatLogWire.record({
        at: performance.now(),
        opcode: 'SMSG_PERIODICAURALOG',
        target,
        caster,
        spellId,
        amount: tick.amount,
        school: tick.school,
        absorb: tick.absorb,
        resist: tick.resist,
        crit: tick.crit,
        missCode: null,
        bodySize,
        consumed: gp.index - gp.headerSize,
      });
      // ONLY THE DAMAGE ARM REACHES THE DISPLAY, and that is the reference's finding rather than a
      // shortcut: "DoT ticks float like direct damage; heal/energize/leech ticks float NOTHING"
      // (`net/apply/combat_log.rs:250-252`). A heal tick is still emitted -- the portrait indicator's
      // HEAL feed is a real consumer -- but it is emitted as what it is.
      if (tick.kind === 'damage') {
        this.emit('spell:damage', {
          target,
          caster,
          spellId,
          amount: tick.amount,
          school: tick.school,
          absorb: tick.absorb,
          resist: tick.resist,
          crit: tick.crit,
          periodic: true,
        } as SpellDamageEvent);
      } else if (tick.kind === 'heal') {
        this.emit('spell:heal', {
          target, caster, spellId, amount: tick.amount, crit: tick.crit, periodic: true,
        });
      }
    }
  }

  /**
   * One `SMSG_PERIODICAURALOG` entry's payload, by `AuraType`. `null` means the width is unknown.
   *
   * 3.3.5a payloads, and the three that differ from the reference's 1.12 shapes are marked:
   *
   *  - DAMAGE (3) / DAMAGE_PERCENT (89): `amount u32` · **`overDamage u32`** · `school u32` ·
   *    `absorb u32` · `resist i32` · **`critical u8`**. The reference's 1.12 form is
   *    `{amount, school, absorb, resist}` -- no overkill and no crit byte, 9 bytes shorter.
   *  - HEAL (8) / OBS_MOD_HEALTH (20): `amount u32` · **`overHeal u32`** · **`absorb u32`** ·
   *    **`critical u8`**. The reference's 1.12 form is `{amount}` alone.
   *  - OBS_MOD_POWER (21) / ENERGIZE (24): `power u32` · `amount u32`. Unchanged.
   *  - MANA_LEECH (64): `power u32` · `amount u32` · `multiplier f32`. Unchanged.
   *
   * Note the ORDER inside the energize pair: the power type comes FIRST and the amount second, which
   * is the opposite of `SMSG_SPELLENERGIZELOG`'s reading order only by coincidence of both being u32
   * -- swapping them would be undetectable by the residual check, so it is stated here. The
   * reference reads them the same way round (`combat_log.rs:129-132`).
   */
  private readPeriodicTick(gp: GamePacket, auraType: number): PeriodicTick | null {
    const blank = { school: 0, absorb: 0, resist: 0, crit: false, power: 0 };
    switch (auraType) {
      case AURA_PERIODIC_DAMAGE:
      case AURA_PERIODIC_DAMAGE_PERCENT: {
        const amount = gp.readUnsignedInt() >>> 0;
        gp.readUnsignedInt(); // overDamage (overkill) -- WotLK only
        const school = gp.readUnsignedInt() >>> 0;
        const absorb = gp.readUnsignedInt() >>> 0;
        const resist = gp.readInt();
        const crit = gp.readUnsignedByte() !== 0;
        return {
          ...blank, kind: 'damage', amount, school, absorb, resist, crit,
        };
      }
      case AURA_PERIODIC_HEAL:
      case AURA_OBS_MOD_HEALTH: {
        const amount = gp.readUnsignedInt() >>> 0;
        gp.readUnsignedInt(); // overHeal -- WotLK only
        const absorb = gp.readUnsignedInt() >>> 0;
        const crit = gp.readUnsignedByte() !== 0;
        return {
          ...blank, kind: 'heal', amount, absorb, crit,
        };
      }
      case AURA_OBS_MOD_POWER:
      case AURA_PERIODIC_ENERGIZE: {
        const power = gp.readUnsignedInt() >>> 0;
        const amount = gp.readUnsignedInt() >>> 0;
        return { ...blank, kind: 'energize', amount, power };
      }
      case AURA_PERIODIC_MANA_LEECH: {
        const power = gp.readUnsignedInt() >>> 0;
        const amount = gp.readUnsignedInt() >>> 0;
        gp.readFloat(); // gain multiplier
        return { ...blank, kind: 'leech', amount, power };
      }
      default:
        return null;
    }
  }

  /**
   * `SMSG_SPELLHEALLOG` (**0x150**) -- a direct heal landing.
   *
   * 3.3.5a body: target PACKED · healer PACKED · `spellId u32` · `amount u32` · **`overHeal u32`** ·
   * **`absorb u32`** · `critical u8` · `unused u8`. The reference's 1.12 form ends at the crit byte
   * with no overheal and no absorb (`combat_log.rs:164-172`), so reading it here would take
   * `overHeal`'s low byte as the crit flag -- a heal that overhealed by any multiple of 256 would
   * read as a non-crit and every other one as a crit.
   *
   * **NO FLOATING WORLD TEXT.** "Heals never float as worldtext" is the reference's own statement
   * (`net/apply/combat_log.rs:424-426`); the heal's medium is the portrait indicator's `HEAL` action.
   */
  private handleSpellHeal(gp: GamePacket): void {
    const bodySize = gp.bodySize;
    const target = gp.readPackedGUID();
    const caster = gp.readPackedGUID();
    const spellId = gp.readUnsignedInt() >>> 0;
    const amount = gp.readUnsignedInt() >>> 0;
    gp.readUnsignedInt(); // overHeal -- WotLK only
    const absorb = gp.readUnsignedInt() >>> 0;
    const crit = gp.readUnsignedByte() !== 0;

    if (!this.validate('SMSG_SPELLHEALLOG', gp, bodySize)) {
      return;
    }
    combatLogWire.record({
      at: performance.now(),
      opcode: 'SMSG_SPELLHEALLOG',
      target,
      caster,
      spellId,
      amount,
      school: 0,
      absorb,
      resist: 0,
      crit,
      missCode: null,
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    this.emit('spell:heal', {
      target, caster, spellId, amount, crit, periodic: false,
    });
  }

  /**
   * `SMSG_SPELLENERGIZELOG` (**0x151**) -- an instant power gain.
   *
   * 3.3.5a body: target PACKED · caster PACKED · `spellId u32` · `powerType u32` · `amount u32`.
   * Unchanged from the reference's 1.12 shape (`combat_log.rs:196-206`).
   *
   * **NOTHING IS DISPLAYED, and that is a declared gap rather than a silent drop.** The reference
   * routes it only to the SCROLLING CENTER combat text, which this client has no host for
   * ("the 5875 engine has no ENERGIZE emission -- the string is absent from the whole binary ...
   * the shipped `CombatFeedback.lua` ENERGIZE arm is dead code", `net/apply/combat_log.rs:466-470`).
   * So there is no `UNIT_COMBAT` to fire and no number to float. It is decoded because leaving it
   * undecoded is how the other four came to be invisible, and because its residual is a free check on
   * this family's packed-guid reading. The event is emitted for a future consumer.
   */
  private handleSpellEnergize(gp: GamePacket): void {
    const bodySize = gp.bodySize;
    const target = gp.readPackedGUID();
    const caster = gp.readPackedGUID();
    const spellId = gp.readUnsignedInt() >>> 0;
    const power = gp.readUnsignedInt() >>> 0;
    const amount = gp.readUnsignedInt() >>> 0;

    if (!this.validate('SMSG_SPELLENERGIZELOG', gp, bodySize)) {
      return;
    }
    combatLogWire.record({
      at: performance.now(),
      opcode: 'SMSG_SPELLENERGIZELOG',
      target,
      caster,
      spellId,
      amount,
      school: 0,
      absorb: 0,
      resist: 0,
      crit: false,
      missCode: null,
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    this.emit('spell:energize', {
      target, caster, spellId, power, amount,
    });
  }

  /**
   * `SMSG_SPELLLOGMISS` (**0x24B**) -- a cast's per-target miss list. THE "dodge" the owner cannot see
   * when it comes from a spell.
   *
   * 3.3.5a body: `spellId u32` · caster **FULL u64** · `useExtended u8` · `count u32` · `count`
   * entries of `{ target FULL u64, missInfo u8 }`, each entry carrying a trailing `2 x f32` when
   * `useExtended` is set.
   *
   * **THE GUIDS ARE FULL, NOT PACKED**, alone in this family -- the same disagreement
   * `SMSG_ATTACKSTART` and `SMSG_ATTACKSTOP` genuinely have with each other in `combat.ts`, and for
   * the same reason: these are separate server builders, not one convention. Reading them packed
   * desyncs immediately, which the residual check would report.
   *
   * `missInfo` is `SpellMissInfo` 1..11, the SAME vocabulary the melee word table is indexed by --
   * see `classes/combat-text.ts#WORD_KEY`, whose comment already records that the client's own key
   * table is bit-for-bit this enum. So a spell's dodge and a swing's dodge cannot print different
   * words, by construction.
   */
  private handleSpellLogMiss(gp: GamePacket): void {
    const bodySize = gp.bodySize;
    const spellId = gp.readUnsignedInt() >>> 0;
    const caster = this.readFullGuid(gp);
    const useExtended = gp.readUnsignedByte();
    const count = gp.readUnsignedInt() >>> 0;

    const misses: { target: string; code: number }[] = [];
    for (let i = 0; i < count; ++i) {
      if (gp.index + 9 > gp.length) {
        this.warnOnce('SMSG_SPELLLOGMISS', `count ${count} runs past the body (${bodySize} B)`);
        return;
      }
      const target = this.readFullGuid(gp);
      const code = gp.readUnsignedByte();
      if (useExtended !== 0) {
        gp.readFloat();
        gp.readFloat();
      }
      misses.push({ target, code });
    }

    if (!this.validate('SMSG_SPELLLOGMISS', gp, bodySize)) {
      return;
    }
    for (const miss of misses) {
      combatLogWire.record({
        at: performance.now(),
        opcode: 'SMSG_SPELLLOGMISS',
        target: miss.target,
        caster,
        spellId,
        amount: 0,
        school: 0,
        absorb: 0,
        resist: 0,
        crit: false,
        missCode: miss.code,
        bodySize,
        consumed: gp.index - gp.headerSize,
      });
      this.emit('spell:miss', { target: miss.target, caster, spellId, code: miss.code });
    }
  }

  /**
   * DID THE LAYOUT ADD UP? The only check these server-sourced layouts have.
   *
   * A decode that ran PAST the end of the body announces nothing: every value after the overrun is
   * whatever `ByteBuffer` returned past the frame, and floating an invented number is worse than
   * floating none. A decode that stopped SHORT is allowed -- these packets have optional and unread
   * tails, exactly as `SMSG_CREATURE_QUERY_RESPONSE` does -- but the residual is recorded either way
   * and `combatLogWire.census()` is where a wrong-but-in-range layout shows itself, as a scattered or
   * growing residual instead of one repeated value.
   */
  private validate(opcode: string, gp: GamePacket, bodySize: number): boolean {
    const consumed = gp.index - gp.headerSize;
    if (consumed > bodySize) {
      this.warnOnce(opcode, `read ${consumed} B of a ${bodySize} B body -- the layout is wrong and nothing was announced`);
      return false;
    }
    return true;
  }

  /** One warning per opcode per distinct message -- these repeat at the tick rate of a DoT. */
  private warned = new Set<string>();

  private warnOnce(opcode: string, detail: string): void {
    const key = `${opcode}:${detail}`;
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    console.warn(
      `combat-log: ${opcode} did not decode -- ${detail}. These layouts come from a SERVER`
      + ' implementation (see the header of network/game/object/combat-log.ts) and are validated'
      + ' rather than trusted. Read window.combatLogWire.census().',
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
