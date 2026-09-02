/**
 * BUFFS AND DEBUFFS ON THE WIRE -- the feed that did not exist, and the reason the owner sees no auras.
 *
 * The owner: "Также не отображаются ауры и бафы с дебафами наложенные на персонажа." That is not a
 * display defect. `SMSG_AURA_UPDATE` (0x496) and `SMSG_AURA_UPDATE_ALL` (0x495) were present in
 * `opcode.js`, NAMED, framed, emitted and dropped with **no subscriber** -- the same state
 * `SMSG_INITIALIZE_FACTIONS` and the whole `SMSG_QUESTGIVER_*` family were in before their handlers
 * landed. `api/units.ts` recorded the consequence in as many words: `UnitAura`, `UnitBuff` and
 * `UnitDebuff` were declared gaps reading "auras are not read out of the update fields yet", and
 * `methods/gametooltip.ts` declared `SetUnitAura` a gap reading "SMSG_AURA_UPDATE has no subscriber".
 *
 * ## HOW AURAS REACH A 3.3.5a CLIENT, and why that gap comment's own premise was WRONG
 *
 * **They do NOT come out of the update fields in this build, and this is the sharpest 1.12/3.3.5a
 * difference in the project.** In 1.12 a unit's auras were update FIELDS -- `UNIT_FIELD_AURA` (48
 * slots), `UNIT_FIELD_AURAFLAGS`, `UNIT_FIELD_AURALEVELS`, `UNIT_FIELD_AURAAPPLICATIONS` -- so the
 * reference reads them off the object update and there is no aura packet at all. Those fields were
 * REMOVED after 1.12 and replaced by a dedicated packet pair. Two independent checks that this build is
 * the later shape, both from data already in this repo:
 *
 *  1. **This client's own 3.3.5a field enumeration has no aura fields.** `network/game/object/enums.ts`
 *     carries `unit_field_aurastate` (0x0037) -- the *aura STATE* bitmask, a different thing that gates
 *     `casterAuraState` cast requirements -- and NO `unit_field_aura`, `..._auraflags`,
 *     `..._auralevels` or `..._auraapplications`. Grepped: `AURA` appears in that file exactly once.
 *  2. **The opcodes exist in this build's own table.** `network/game/opcode.js:1175-1176` --
 *     `SMSG_AURA_UPDATE_ALL = 0x495`, `SMSG_AURA_UPDATE = 0x496` -- and they sit inside a block above
 *     every opcode a 1.12 table has. A 1.12 client has no such opcodes.
 *
 * So the feed is the packet pair, and the slot model is the server's: a unit holds a sparse map of
 * `slot -> aura`, the server sends ONE `SMSG_AURA_UPDATE` per application or removal, and a REMOVAL is
 * an entry whose spell id is **zero**. `SMSG_AURA_UPDATE_ALL` is the same entry format repeated to the
 * end of the body and is a full replacement of that unit's map.
 *
 * ## WHERE THE FIELD LAYOUT COMES FROM, stated plainly
 *
 * **The opcode NUMBERS are this client's own 3.3.5a table** (above). **The BODY LAYOUT is a SERVER
 * IMPLEMENTATION** -- TrinityCore's 3.3.5 branch, `AuraApplication::BuildUpdatePacket` with
 * `Unit::SendAuraUpdate` and `Unit::SendAuraUpdateAll` around it. That is the same class of source, and
 * carries the same label, as `combat-log.ts`'s five layouts, the `HitInfo` bits, the NPC service flags
 * and `CMSG_SET_ACTION_BUTTON`'s `u8` slot prefix. Nothing in the game's own data states a packet body:
 * no DBC carries one and the client's own Lua is handed already-decoded values, so FrameXML cannot
 * corroborate a byte offset. **The reference cannot corroborate it either** -- see above; there is no
 * 1.12 twin of this packet to compare against, which makes this family unusually dependent on its own
 * residual. Hence `game/classes/aura-wire.ts`, which closes to residual ZERO when the layout is right.
 *
 * 3.3.5a body, both opcodes:
 *
 *     unit PACKED guid
 *     then, once (SMSG_AURA_UPDATE) or repeated to the end of the body (SMSG_AURA_UPDATE_ALL):
 *       slot            u8
 *       spellId         u32     -- ZERO means "this slot is now empty"; nothing follows it
 *       flags           u8      -- AuraFlags, below
 *       casterLevel     u8
 *       applications    u8      -- stacks, or charges for a charge-bearing aura
 *       caster          PACKED guid, ONLY when (flags & AFLAG_CASTER) == 0
 *       maxDuration     u32     -- ms, ONLY when (flags & AFLAG_DURATION) != 0
 *       duration        u32     -- ms REMAINING, same condition
 *
 * **THE TWO CONDITIONAL BLOCKS ARE THE WHOLE RISK IN THIS FILE.** Reading a caster guid that is not
 * there, or skipping one that is, desynchronises every later entry of an `_ALL` -- and unlike a fixed
 * stride, the error is not a constant offset, so it cannot be spotted by eye in a decoded value. That is
 * why the residual is DIAGNOSED rather than merely printed (`aura-wire.ts#diagnose`), and why a correct
 * read of this family has to close to exactly zero: the packet has no optional tail to excuse a
 * remainder.
 *
 * **`duration` IS REMAINING, NOT ELAPSED**, and it is milliseconds. It is converted ONCE, at receipt,
 * into an absolute expiry on the client's own `GetTime()` clock -- see `AuraEntry#expiresAt`. Storing
 * the remaining time and subtracting per read is what would make a getter's answer change every frame;
 * see the cost note in `game/ui/aura-bridge.ts`.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GameOpcode from '../opcode';
import GamePacket from '../packet';
import { auraWire } from '../../../game/classes/aura-wire';
import { gameTime } from '../../../game/ui/framexml/lua/compat';

/**
 * `AuraFlags`, from the same server implementation as the layout.
 *
 * The two that decide what a player SEES are `POSITIVE` and `NEGATIVE`: they are what splits the
 * client's `HELPFUL` filter from `HARMFUL`, and they are set on the SERVER from the spell's own
 * positive/negative evaluation combined with who cast it. Worth stating because the alternative --
 * deciding helpful/harmful here from `Spell.dbc` -- would disagree with the server on exactly the cases
 * that matter (a nominally friendly spell cast by an enemy, a debuff a player puts on himself), and it
 * would disagree silently.
 *
 * `CASTER` means "the caster IS this unit", which is why it SUPPRESSES the caster guid rather than
 * introducing it. Read the wrong way round it reads a guid out of the duration words.
 */
export const AFLAG_CASTER = 0x08;
export const AFLAG_POSITIVE = 0x10;
export const AFLAG_DURATION = 0x20;
export const AFLAG_NEGATIVE = 0x80;

/** One aura in one slot of one unit. Everything `UnitAura` answers, and nothing else. */
export interface AuraEntry {
  /** The server's slot. The ONE stable identity an aura has; `UnitAura`'s index is a position, not this. */
  slot: number;
  spellId: number;
  flags: number;
  casterLevel: number;
  /** Stacks (or charges). The client shows it only above 1 (`buffframe.lua:208`). */
  applications: number;
  /** The caster's guid, or null when the aura is self-cast (`AFLAG_CASTER`). */
  caster: string | null;
  /** `maxDuration` in SECONDS, 0 for a permanent aura. `UnitAura`'s sixth return. */
  duration: number;
  /**
   * Absolute expiry on the `GetTime()` clock, or null for a permanent aura -- `UnitAura`'s seventh
   * return, verbatim, so the getter is a field read and not arithmetic.
   *
   * COMPUTED ONCE HERE, at receipt. `AuraButton_Update` stores `expirationTime - GetTime()` itself
   * (`buffframe.lua:190`) and `AuraButton_OnUpdate` decrements its own copy by `elapsed`, so the client
   * already does all the per-frame work; a getter that recomputed a remaining time would be doing it
   * twice and its answer would differ between two reads in the same frame.
   */
  expiresAt: number | null;
}

export class AuraHandler extends EventEmitter {
  private game: GameHandler;

  /** guid -> slot -> aura. Sparse, exactly as the server's own visible-aura map is. */
  private byUnit = new Map<string, Map<number, AuraEntry>>();

  /**
   * Bumped on every change, so a bridge can memoise a filtered list against it rather than rebuilding
   * one per `UnitAura` call -- and `BuffFrame_Update` alone makes 48 of those per event.
   */
  public version = 0;

  /**
   * How many entries arrived carrying NEITHER `AFLAG_POSITIVE` nor `AFLAG_NEGATIVE`.
   *
   * A counter and not a warning, because the server implementation's own flag initialisation sets
   * exactly one of the two on every path -- so this should stay at 0, and if it does not, the
   * helpful/harmful split in `aura-bridge.ts` is running on its fallback and a probe can see it.
   * Reading a number here is the difference between "the classification is sound" and "the
   * classification looked sound".
   */
  public unclassified = 0;

  constructor(gameHandler: GameHandler) {
    super();
    this.game = gameHandler;
    this.subscribe('SMSG_AURA_UPDATE', (gp) => this.readPacket(gp, 'SMSG_AURA_UPDATE', false));
    this.subscribe('SMSG_AURA_UPDATE_ALL', (gp) => this.readPacket(gp, 'SMSG_AURA_UPDATE_ALL', true));
  }

  /**
   * Subscribe one arm with the over-read catch around it -- `combat-log.ts#subscribe`'s reasoning
   * verbatim, and it applies harder here.
   *
   * `byte-buffer` RAISES on a short read (`dist/byte-buffer.js:584-586`) and
   * `GameHandler#dataReceived` emits with no `try` (`network/game/handler.js:199-201`), so an uncaught
   * throw takes every packet still buffered in that data event with it. This family's two conditional
   * blocks make a wrong stride a real possibility rather than a theoretical one, and an over-read is
   * the one failure a residual number cannot express -- so it is caught, recorded as `!THREW`, and
   * named once.
   */
  private subscribe(name: string, arm: (gp: GamePacket) => void): void {
    this.game.on(`packet:receive:${name}`, (gp: GamePacket) => {
      const bodySize = gp.bodySize;
      try {
        arm(gp);
      } catch (e) {
        auraWire.record({
          at: performance.now(),
          opcode: `${name}!THREW`,
          unit: '',
          entries: 0,
          slots: [],
          spellIds: [],
          bodySize,
          consumed: gp.index - gp.headerSize,
        });
        this.warnOnce(name, `read past the ${bodySize} B body -- ${(e as Error).message}`);
      }
    });
  }

  /**
   * Both opcodes, one reader -- they differ only in whether the entry block repeats and in whether the
   * unit's existing map survives.
   *
   * `SMSG_AURA_UPDATE_ALL` REPLACES the map. That is the server's own meaning ("here are all of them")
   * and getting it wrong the other way would leave an aura on screen forever after the one event that
   * sends this packet, which is the failure mode this decision exists to avoid.
   */
  private readPacket(gp: GamePacket, opcode: string, all: boolean): void {
    const bodySize = gp.bodySize;
    const unit = gp.readPackedGUID();

    const existing = this.byUnit.get(unit);
    const slots: Map<number, AuraEntry> = all ? new Map() : existing ?? new Map();
    const seenSlots: number[] = [];
    const seenSpells: number[] = [];
    let changed = all && existing !== undefined && existing.size > 0;

    // `all` reads to the END OF THE BODY: this packet carries no count word at all. The MINIMUM entry
    // is 5 bytes (slot + spellId), which is what a removal is, so a remainder below that is a tail and
    // not a truncated entry -- and it shows up as `header-or-tail` in the diagnosis rather than being
    // silently consumed.
    const MIN_ENTRY = 1 + 4;
    do {
      if (gp.index + MIN_ENTRY > gp.length) {
        break;
      }
      const slot = gp.readUnsignedByte();
      const spellId = gp.readUnsignedInt() >>> 0;
      seenSlots.push(slot);
      seenSpells.push(spellId);
      if (spellId === 0) {
        // A REMOVAL, and nothing follows it in the entry -- the server writes `uint32(0)` and returns.
        if (slots.delete(slot)) {
          changed = true;
        }
        continue;
      }
      const flags = gp.readUnsignedByte();
      const casterLevel = gp.readUnsignedByte();
      const applications = gp.readUnsignedByte();
      // SUPPRESSED by the flag, not introduced by it -- see `AFLAG_CASTER`.
      const caster = (flags & AFLAG_CASTER) === 0 ? gp.readPackedGUID() : null;
      let duration = 0;
      let expiresAt: number | null = null;
      if ((flags & AFLAG_DURATION) !== 0) {
        const maxMs = gp.readUnsignedInt() >>> 0;
        const remainingMs = gp.readUnsignedInt() >>> 0;
        duration = maxMs / 1000;
        // Absolute, once. See `AuraEntry#expiresAt`.
        expiresAt = gameTime() + remainingMs / 1000;
      }
      if ((flags & (AFLAG_POSITIVE | AFLAG_NEGATIVE)) === 0) {
        this.unclassified += 1;
      }
      slots.set(slot, {
        slot, spellId, flags, casterLevel, applications, caster, duration, expiresAt,
      });
      changed = true;
    } while (all);

    if (slots.size === 0) {
      this.byUnit.delete(unit);
    } else {
      this.byUnit.set(unit, slots);
    }

    auraWire.record({
      at: performance.now(),
      opcode: seenSlots.length === 0 ? `${opcode}!EMPTY` : opcode,
      unit,
      entries: seenSlots.length,
      slots: seenSlots,
      spellIds: seenSpells,
      bodySize,
      consumed: gp.index - gp.headerSize,
    });

    if (changed) {
      this.version += 1;
      this.emit('auras', unit);
    }
  }

  /**
   * One unit's auras in SLOT order, which is the order `UnitAura`'s index walks.
   *
   * Slot order rather than arrival order, and that is not arbitrary: a slot is the server's own stable
   * identity for an aura, so `UnitAura(unit, 3, "HELPFUL")` names the same aura across two calls even
   * when something else was applied or fell off in between. Arrival order would renumber the whole bar
   * on every application and `BuffButton3` would swap icons under the cursor.
   */
  forUnit(guid: string): AuraEntry[] {
    const slots = this.byUnit.get(guid);
    if (slots === undefined) {
      return [];
    }
    return [...slots.values()].sort((a, b) => a.slot - b.slot);
  }

  /** Drop a unit's auras -- the destroy path, so a despawned mob does not keep its debuffs in the map. */
  forget(guid: string): void {
    if (this.byUnit.delete(guid)) {
      this.version += 1;
    }
  }

  /** How many units are being tracked, for the population half of a cost measurement. */
  get trackedUnits(): number {
    return this.byUnit.size;
  }

  /**
   * Every guid this handler holds auras for.
   *
   * For the re-sweep in `aura-visuals.ts`: the aura feed is not gated on the object feed, so a unit's
   * auras can arrive before its create block and before `spellData` has loaded, and neither of those
   * produces a second `'auras'` emit to re-drive the visual off. Iterating the keys is how that sweep
   * finds the units it already knows about.
   */
  trackedGuids(): string[] {
    return [...this.byUnit.keys()];
  }

  /**
   * `CMSG_CANCEL_AURA` (**0x136**): dismiss one of OUR OWN buffs -- what a right click on a buff icon
   * does (`BuffButton_OnClick` -> `CancelUnitBuff`, `buffframe.lua:271-273`).
   *
   * 3.3.5a body: `u32 spellId`, and nothing else. SERVER-IMPLEMENTATION source like the layouts above
   * (the 3.3.5 cancel-aura handler reads one `uint32`). **A width is the whole risk on a send**: this
   * project has found eleven-plus silent 1.12->3.3.5a widenings, and a short body makes the server's
   * `ByteBuffer` read past the end and throw, which discards the packet and sends NOTHING back -- so a
   * wrong width here would look like a right click that did nothing rather than one that was refused.
   * Four bytes is the width in both builds, so there is nothing to widen; recorded because "nothing to
   * widen" is a finding rather than the absence of one.
   *
   * There is no reply on success either: the buff going away arrives as an ordinary
   * `SMSG_AURA_UPDATE` with spell id 0 in that slot. So the icon disappearing IS the acknowledgement,
   * and it is also the only confirmation the width was right.
   */
  cancelAura(spellId: number): void {
    const body = 4;
    const app = new GamePacket(GameOpcode.CMSG_CANCEL_AURA, GamePacket.HEADER_SIZE_OUTGOING + body);
    app.writeUnsignedInt(spellId);
    this.game.send(app);
  }

  /** One warning per opcode per distinct message -- see `combat-log.ts#warnOnce`. */
  private warned = new Set<string>();

  private warnOnce(opcode: string, detail: string): void {
    const key = `${opcode}:${detail}`;
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    console.warn(
      `auras: ${opcode} did not decode -- ${detail}. This layout comes from a SERVER implementation`
      + ' (see the header of network/game/object/auras.ts), has no 1.12 twin to corroborate it, and is'
      + ' validated rather than trusted. Read window.auraWire.census().',
    );
  }
}
