/**
 * Spells and the action bar -- the six opcodes that were in `opcode.js` with NO SUBSCRIBER ANYWHERE.
 *
 * This is the same situation `combat.ts`'s header describes, and it is why the action bar was empty. The
 * server ALREADY tells us everything a bar needs, at entry, unprompted: `SMSG_INITIAL_SPELLS` (0x12A)
 * and `SMSG_ACTION_BUTTONS` (0x129) both arrive in the login burst and were framed, named, emitted and
 * dropped. Nothing was missing from the wire; nothing read it.
 *
 * ## Layouts, and where each came from
 *
 * The reference is `samples/benilla/crates/benilla-protocol/src/messages/spells.rs`, which byte-verifies
 * each layout against vmangos' own builders. **benilla is 1.12.1 and three of these differ in 3.3.5a**,
 * and this is exactly the class of mistake that cost this project four rounds already
 * (`SMSG_ATTACKERSTATEUPDATE`, base attack time, the update-field offsets). Every delta is stated at the
 * read:
 *
 *  - `SMSG_SPELL_START` / `SMSG_SPELL_GO`: the reference reads `pguid item, pguid caster, u32 spellId,
 *    u16 castFlags` (`spells.rs:141-152`). 3.3.5a **inserts a `u8 castCount` between the caster guid and
 *    the spell id**, and **widens `castFlags` from `u16` to `u32`**. Reading the reference's form here
 *    puts the spell id one byte early and everything after it three bytes short.
 *  - `CMSG_CAST_SPELL`: the reference's 1.12 body is `u32 spellId` then targets. 3.3.5a is
 *    `u8 castCount, u32 spellId, u8 castFlags`, then targets -- `castCount` did not exist in 1.12.
 *  - `SMSG_INITIAL_SPELLS`: the reference's spell entries are `u16 spellId, u16 slot`. 3.3.5a widens the
 *    id to `u32`, giving 6-byte entries.
 *
 * ## The two entry-burst layouts are pinned by arithmetic before a byte is decoded
 *
 * Both packet sizes were recorded in an entry capture, and each size has exactly one small solution:
 *
 *  - `SMSG_INITIAL_SPELLS` = **329 B**. `u8 unk` + `u16 spellCount` + 6 B per spell + `u16
 *    cooldownCount` + 14 B per cooldown gives `1 + 2 + 6n + 2 + 14m = 329`, so `6n + 14m = 324`. With
 *    `m = 0`, `n = 54` exactly. A freshly-entered character knowing 54 spells with no active cooldown is
 *    precisely what is expected, and 6-byte entries are what make it come out whole -- the reference's
 *    4-byte entries would need `n = 81` with 0 remainder, which is possible, so this alone does not
 *    settle it; the decode's own `consumed == bodySize` check does, and that is why it is recorded.
 *  - `SMSG_ACTION_BUTTONS` = **577 B**. `u8 packetType` + `u32` per slot x 144 slots = `1 + 576`, an
 *    exact fit. 144 is 3.3.5a's `MAX_ACTION_BUTTONS` (12 buttons x 12 pages) and the fit rules out the
 *    2.4.3 form (120 slots).
 *
 * `spellWire` (`game/classes/spell-wire.ts`) records `consumed` against `bodySize` for every arrival, so
 * a wrong layout is visible as a wrong remainder rather than as a feature that quietly misbehaves.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GameOpcode from '../opcode';
import GamePacket from '../packet';
import { GUID_BYTES, guidBytes } from '../../guid-hex';
import { castAnimationFor } from '../../../game/classes/spell-anim';
import { spellData } from '../../../game/pipeline/dbc/spell-data';
import { spellWire } from '../../../game/classes/spell-wire';

/**
 * 3.3.5a `MAX_ACTION_BUTTONS`: 12 buttons x 12 pages. Load-bearing -- it is what makes the recorded
 * 577-byte body an exact fit, and reading a different count desyncs the whole slot array.
 */
export const MAX_ACTION_BUTTONS = 144;

/**
 * An action slot's packed `u32`: the low 24 bits are the action, the high 8 the type.
 *
 * vmangos and TrinityCore both store the button this way (`ActionButton::packedData`,
 * `GetActionButtonType`/`GetActionButtonAction`), and it is why the slot array is 4 bytes per entry
 * rather than 5.
 */
const ACTION_MASK = 0x00ffffff;

/** `ACTION_BUTTON_SPELL`. The only type this client can act on today; the others are named and skipped. */
export const ACTION_BUTTON_SPELL = 0x00;

/** `ACTION_BUTTON_ITEM`, `ACTION_BUTTON_MACRO`, `ACTION_BUTTON_EQSET`, `ACTION_BUTTON_C` (companion). */
const ACTION_BUTTON_TYPE_NAMES: Record<number, string> = {
  0x00: 'spell',
  0x01: 'companion',
  0x20: 'equipmentset',
  0x40: 'macro',
  0x41: 'companionmacro',
  0x80: 'item',
};

/** One action-bar slot as the server sent it. `type` 0 with `action` 0 is an empty slot. */
export interface ActionSlot {
  action: number;
  type: number;
}

/** `spell 6603 "Auto Attack"` -- the melee auto-attack, which in the real client is a SPELL ON A BUTTON. */
export const SPELL_AUTO_ATTACK = 6603;

export class SpellHandler extends EventEmitter {
  private game: GameHandler;

  /** Every spell the character knows, from `SMSG_INITIAL_SPELLS`. */
  private known = new Set<number>();

  /**
   * The 144 action slots, indexed 0-based by slot. The Lua side is 1-based (`ActionButton.lua`'s
   * `action` runs 1..144), and `slot(action)` below is the single place that conversion happens.
   */
  private slots: ActionSlot[] = [];

  /**
   * Whether melee auto-attack is currently on, so the auto-attack BUTTON can reflect and toggle it.
   *
   * Driven by `SMSG_ATTACKSTART`/`SMSG_ATTACKSTOP` naming us rather than by what we sent, because the
   * server is the authority: a `CMSG_ATTACKSWING` that is refused leaves the button un-checked, which is
   * what the real client shows.
   */
  private autoAttacking = false;

  constructor(gameHandler: GameHandler) {
    super();
    this.game = gameHandler;
    this.game.on('packet:receive:SMSG_INITIAL_SPELLS', this.handleInitialSpells.bind(this));
    this.game.on('packet:receive:SMSG_ACTION_BUTTONS', this.handleActionButtons.bind(this));
    this.game.on('packet:receive:SMSG_SPELL_START', this.handleSpellStart.bind(this));
    this.game.on('packet:receive:SMSG_SPELL_GO', this.handleSpellGo.bind(this));
    this.game.on('packet:receive:SMSG_CAST_FAILED', this.handleCastFailed.bind(this));
  }

  // -- Reads --------------------------------------------------------------------------------------

  /**
   * `SMSG_INITIAL_SPELLS` (0x12A): every spell the character knows, plus any cooldown already running.
   *
   * 3.3.5a body: `u8 unk` (talent-spec byte, always 0 in the captures), `u16 spellCount`, then per spell
   * `u32 spellId` + `u16 unk` (a slot/handle the client ignores), then `u16 cooldownCount`, then per
   * cooldown `u32 spellId, u16 itemId, u16 category, u32 cooldownMs, u32 categoryCooldownMs` = 14 B.
   *
   * The reference's entries are `u16 spellId, u16 slot` (1.12 had no spell id above 65535); 3.3.5a needs
   * the wider id -- spell ids in this build run past 70000.
   */
  private handleInitialSpells(gp: GamePacket): void {
    // Every listener on one opcode is handed the SAME packet object and therefore the same read cursor,
    // so a handler that is not the only one must rewind. `protocol/wotlk/world.ts:290` does this for the
    // same reason; doing it unconditionally costs nothing and removes an ordering dependency.
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;

    gp.readUnsignedByte();
    const spellCount = gp.readUnsignedShort();
    const found: number[] = [];
    for (let i = 0; i < spellCount && gp.available >= 6; i += 1) {
      const spellId = gp.readUnsignedInt();
      gp.readUnsignedShort();
      if (spellId !== 0) {
        found.push(spellId);
      }
    }

    let cooldownCount = 0;
    if (gp.available >= 2) {
      cooldownCount = gp.readUnsignedShort();
      // Read past the cooldown blocks to make `consumed` meaningful. Nothing consumes them yet: a live
      // cooldown sweep is deferred, and `methods/cooldown.ts` explains why nothing is drawn.
      for (let i = 0; i < cooldownCount && gp.available >= 14; i += 1) {
        gp.read(14);
      }
    }

    this.known = new Set(found);
    spellWire.record({
      at: Date.now(),
      kind: 'INITIAL_SPELLS',
      spellId: 0,
      caster: null,
      detail: { spellCount, decoded: found.length, cooldownCount, first: found[0] ?? null },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });

    // NOTE what is deliberately NOT done here: the DBC tables are not loaded. `Spell.dbc` is 49 MB and
    // this packet arrives in the LOGIN BURST, while `FrameXML.toc`'s 264 files are still being fetched.
    // Kicking the 49 MB fetch off here starved that manifest load over the same connection -- MEASURED:
    // the FrameXML boot did not finish in 240 s and `window.worldRuntime` never appeared, with no error
    // anywhere, which is exactly the kind of silent starvation this project has been bitten by. The
    // tables are loaded by `ui/action-bridge.ts`, which attaches only AFTER the manifest is in.
    this.emit('spellsChanged');
  }

  /**
   * `SMSG_ACTION_BUTTONS` (0x129): all 144 slots.
   *
   * 3.3.5a body: `u8 packetType`, then 144 x `u32 packedData`. `packetType` 0 is a full send; a
   * non-zero type can carry no slots at all, which is why the loop is bounded by `available` as well as
   * by the count.
   */
  private handleActionButtons(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;

    const packetType = gp.readUnsignedByte();
    const slots: ActionSlot[] = [];
    let filled = 0;
    for (let i = 0; i < MAX_ACTION_BUTTONS && gp.available >= 4; i += 1) {
      const packed = gp.readUnsignedInt();
      const action = packed & ACTION_MASK;
      // `>>> 24`, not `>> 24`: a slot whose type byte is 0x80 (`ACTION_BUTTON_ITEM`) makes the packed
      // word exceed 2^31, and a signed shift would give a negative type.
      const type = packed >>> 24;
      slots.push({ action, type });
      if (action !== 0) {
        filled += 1;
      }
    }
    this.slots = slots;

    spellWire.record({
      at: Date.now(),
      kind: 'ACTION_BUTTONS',
      spellId: 0,
      caster: null,
      detail: { packetType, slots: slots.length, filled },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });

    // Not loading the tables here either -- see `handleInitialSpells`.
    this.emit('actionsChanged');
  }

  /**
   * `SMSG_SPELL_START` (0x131): a cast BEGAN. Read for the record; nothing acts on it.
   *
   * A cast bar is deferred (`CastingBarFrame` is correctly hidden today), and the caster's animation is
   * armed at SPELL_GO rather than here -- which is the reference's own rule: "**`SpellCastOmni` (54) is
   * armed at SPELL_GO**" (`benilla/src/creature_anim/driver.rs:616`). So this handler exists to prove the
   * layout and to give the deferred cast bar a place to land.
   */
  private handleSpellStart(gp: GamePacket): void {
    const decoded = this.readCastHead(gp, 'SPELL_START');
    if (decoded !== null) {
      this.emit('spellStart', decoded);
    }
  }

  /**
   * `SMSG_SPELL_GO` (0x132): the cast LAUNCHED. This is what drives the caster's animation.
   *
   * Only the head is decoded -- the two guids, `castCount`, `spellId`, `castFlags`, `timestamp`. The tail
   * (hit list, miss list, targets, and blocks gated on `castFlags`) is deliberately NOT decoded: nothing
   * consumes it, spell visual kits are out of scope for this round, and a decode with no consumer is a
   * decode nobody would notice going wrong. `consumed` will therefore be well short of `bodySize` for
   * this opcode BY DESIGN -- unlike the two entry packets, where a short read is a defect.
   */
  private handleSpellGo(gp: GamePacket): void {
    const decoded = this.readCastHead(gp, 'SPELL_GO');
    if (decoded === null) {
      return;
    }

    // THE CASTER'S OWN CLIP. Armed here, at GO, which is the reference's rule -- see `spell-anim.ts`.
    // The caster may be a peer as easily as ourselves, so this is the same plain `entities` lookup the
    // swing and the defense reaction use in `combat.ts`.
    const unit = this.game.world.entities.get(decoded.caster);
    if (unit) {
      const anim = castAnimationFor(unit, decoded.spellId);
      if (anim !== null) {
        // A ONE-SHOT (repetitions 0) with `interrupt` true, exactly as a swing is armed: `setAnimation`'s
        // ownership latch hands the body back to locomotion when the clip's window ends, so a cast does
        // not need a release of its own. The blend layer that landed recently is what makes the entry
        // into it a fade rather than a snap.
        unit.setAnimation(anim, true, 0);
      }
    }

    this.emit('spellGo', decoded);
  }

  /**
   * The shared head of `SMSG_SPELL_START` and `SMSG_SPELL_GO`.
   *
   * `pguid item-or-caster`, `pguid caster`, `u8 castCount`, `u32 spellId`, `u32 castFlags`, `u32` (the
   * remaining cast time on START, `getMSTime` on GO). The first guid is the CAST ITEM's when one is in
   * play and the caster's own otherwise; the second is always the casting unit, so the second is the one
   * to animate (`spells.rs:143-146`).
   *
   * SELF-CHECKING, on the `combatWire` principle: a `spellId` of 0, or one absurdly out of range, means
   * the layout is wrong -- most likely the reference's 1.12 form, which lands the id one byte early. The
   * decode returns null and records the failure rather than arming an animation from garbage.
   */
  private readCastHead(
    gp: GamePacket,
    kind: 'SPELL_START' | 'SPELL_GO',
  ): { caster: string; spellId: number; castFlags: number } | null {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;

    let caster = '0x0';
    let spellId = 0;
    let castFlags = 0;
    try {
      gp.readPackedGUID();
      caster = gp.readPackedGUID();
      gp.readUnsignedByte();
      spellId = gp.readUnsignedInt();
      castFlags = gp.readUnsignedInt();
    } catch (error) {
      spellWire.record({
        at: Date.now(),
        kind,
        spellId: 0,
        caster: null,
        detail: { error: String(error) },
        bodySize,
        consumed: gp.index - gp.headerSize,
      });
      return null;
    }

    // 3.3.5a's highest `Spell.dbc` id is 80864 and the table has 49839 rows, so anything past 100000 is
    // not a spell id -- it is a misaligned read. Checked against a CONSTANT rather than against
    // `spellData`, deliberately: the tables load asynchronously and a check that silently passes while
    // they are absent is the kind of instrument this project has been bitten by twice.
    const plausible = spellId > 0 && spellId < 100000;
    spellWire.record({
      at: Date.now(),
      kind,
      spellId,
      caster,
      detail: {
        castFlags,
        plausible: plausible ? 1 : 0,
        name: spellData.spell(spellId)?.name ?? null,
      },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    if (!plausible) {
      console.warn(
        `${kind}: spellId ${spellId} is not a plausible 3.3.5a spell id -- the layout is probably wrong`,
      );
      return null;
    }
    return { caster, spellId, castFlags };
  }

  /**
   * `SMSG_CAST_FAILED` (0x130): the server refused the cast.
   *
   * 3.3.5a body: `u8 castCount`, `u32 spellId`, `u8 result`, then result-specific args this client does
   * not read. Recorded and emitted; the error TEXT (`SPELL_FAILED_*` through `GlobalStrings.lua`) needs
   * a chat frame, and there is no `ScrollingMessageFrame` yet, so nothing is displayed. Named in
   * STATE.md rather than silently swallowed.
   */
  private handleCastFailed(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;
    gp.readUnsignedByte();
    const spellId = gp.readUnsignedInt();
    const result = gp.readUnsignedByte();
    spellWire.record({
      at: Date.now(),
      kind: 'CAST_FAILED',
      spellId,
      caster: null,
      detail: { result, name: spellData.spell(spellId)?.name ?? null },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    this.emit('castFailed', { spellId, result });
  }

  // -- Writes -------------------------------------------------------------------------------------

  /**
   * `CMSG_CAST_SPELL` (0x12E): cast `spellId` at `target` (or at ourselves when null).
   *
   * 3.3.5a body: `u8 castCount`, `u32 spellId`, `u8 castFlags`, then `SpellCastTargets` -- which is a
   * `u32 targetMask` followed by whatever the mask says. Two masks are used here and nothing else:
   * `TARGET_FLAG_SELF` = 0x0000, which carries NO further data, and `TARGET_FLAG_UNIT` = 0x0002, which
   * carries one PACKED guid.
   *
   * `castCount` is 0 and `castFlags` is 0, which is what the real client sends for a plain button press;
   * `castCount` is the client's own sequence number for matching a `SMSG_CAST_FAILED` back to its cast,
   * and it is echoed rather than validated by the server.
   *
   * NOTE the 1.12 delta: the reference's `CMSG_CAST_SPELL` has no `castCount` and no `castFlags` at all.
   * Sending its form here shifts the target mask by two bytes and the server reads a nonsense mask.
   */
  castSpell(spellId: number, target: string | null): void {
    const TARGET_FLAG_SELF = 0x0000;
    const TARGET_FLAG_UNIT = 0x0002;

    // The body is sized exactly, because `GameHandler#send` derives the packet's declared LENGTH from
    // the buffer size -- an over-allocated buffer sends a wrong length field, which `handler.js` records
    // as a real defect it has already been bitten by.
    const targeted = target !== null && target !== '0x0';
    const guidBytesLength = targeted ? packedGuidLength(target as string) : 0;
    const body = 1 + 4 + 1 + 4 + guidBytesLength;

    const app = new GamePacket(GameOpcode.CMSG_CAST_SPELL, 6 + body);
    app.writeUnsignedByte(0);
    app.writeUnsignedInt(spellId);
    app.writeUnsignedByte(0);
    app.writeUnsignedInt(targeted ? TARGET_FLAG_UNIT : TARGET_FLAG_SELF);
    if (targeted) {
      app.writePackedGUID(target as string);
    }
    this.game.send(app);

    spellWire.record({
      at: Date.now(),
      kind: 'CAST_SENT',
      spellId,
      caster: null,
      detail: {
        target: targeted ? (target as string) : null,
        name: spellData.spell(spellId)?.name ?? null,
        bodyBytes: body,
      },
      bodySize: body,
      consumed: body,
    });
  }

  // -- What the Lua side reads --------------------------------------------------------------------

  /** `action` is Lua's 1-based slot number, as `ActionButton.lua` computes it. */
  slot(action: number): ActionSlot | null {
    if (!Number.isFinite(action) || action < 1 || action > MAX_ACTION_BUTTONS) {
      return null;
    }
    return this.slots[action - 1] ?? null;
  }

  /** The spell in a slot, or null when the slot is empty or holds a macro/item/companion. */
  spellInSlot(action: number): number | null {
    const slot = this.slot(action);
    if (slot === null || slot.action === 0 || slot.type !== ACTION_BUTTON_SPELL) {
      return null;
    }
    return slot.action;
  }

  knownSpells(): ReadonlySet<number> {
    return this.known;
  }

  /** Named types for anything a slot holds that this client cannot act on, for the load report. */
  static typeName(type: number): string {
    return ACTION_BUTTON_TYPE_NAMES[type] ?? `unknown(0x${type.toString(16)})`;
  }

  get autoAttackOn(): boolean {
    return this.autoAttacking;
  }

  /** Driven by `combat.ts` from `SMSG_ATTACKSTART`/`SMSG_ATTACKSTOP` naming us -- see the field. */
  setAutoAttack(on: boolean): void {
    if (this.autoAttacking === on) {
      return;
    }
    this.autoAttacking = on;
    this.emit('autoAttackChanged', on);
  }
}

/**
 * How many bytes `writePackedGUID` will emit for this guid: a mask byte plus one byte per non-zero byte
 * of the little-endian guid.
 *
 * Computed rather than assumed because the body length must be exact (see `castSpell`). This mirrors
 * `net/packet.js#writePackedGUID`'s own loop; it is duplicated rather than exported because the
 * alternative is teaching that JS module to answer a size question it has no other caller for.
 */
function packedGuidLength(guid: string): number {
  // `guidBytes` is the inverse of the single guid formatter (`network/guid-hex.ts`), so this counts the
  // same bytes `writePackedGUID` will decide to emit rather than doing arithmetic on a 64-bit value that
  // would not survive a JS number.
  const bytes = guidBytes(guid);
  let length = 1;
  for (let i = 0; i < GUID_BYTES; i += 1) {
    if (bytes[i] !== 0) {
      length += 1;
    }
  }
  return length;
}
