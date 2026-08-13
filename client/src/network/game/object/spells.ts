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
import { castAnimationFor, precastAnimationFor } from '../../../game/classes/spell-anim';
import { spellData } from '../../../game/pipeline/dbc/spell-data';
import { spellWire } from '../../../game/classes/spell-wire';
// `GetTime()`'s clock. A cooldown's `start` is what the client's own Lua compares against, so the wire
// side has to stamp it on the SAME clock -- see `lua/compat.ts#gameTime`.
import { gameTime } from '../../../game/ui/framexml/lua/compat';

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

  /**
   * THE COOLDOWN TABLE: spell id -> when it started and how long it runs, in `GetTime()` seconds.
   *
   * Two sources, and they are different in kind:
   *
   *  - **The global cooldown is computed here, not received.** Nothing on the wire carries it. When the
   *    server CONFIRMS one of our casts, the 3.3.5a client puts `Spell.dbc.StartRecoveryTime` (column 206,
   *    measured -- see `spell-data.ts`) on every spell sharing the cast spell's `StartRecoveryCategory`.
   *    That is what makes the whole bar dim at once on a cast. The confirmation is `SMSG_SPELL_START` for
   *    a timed cast and `SMSG_SPELL_GO` for an instant, which sends no START at all -- see
   *    `handleSpellStart` for why START rather than GO, and `castStarted` for how the two are kept from
   *    stamping the same cast twice.
   *  - **Real cooldowns come from the server**, through `SMSG_SPELL_COOLDOWN` (0x134) and
   *    `SMSG_COOLDOWN_EVENT` (0x135), and are cleared by `SMSG_CLEAR_COOLDOWN` (0x1DE). The DBC's own
   *    `RecoveryTime` is a fallback for the confirmed cast, since the server does not always send a
   *    packet for a cooldown the client can derive.
   *
   * Entries are never swept on a timer: an expired entry is simply in the past, and `GetActionCooldown`
   * and the sweep pass both read the numbers rather than a boolean. `pruneCooldowns` drops them on the
   * next update so the map cannot grow without bound over a long session.
   */
  private cooldowns = new Map<number, { start: number; duration: number }>();

  /**
   * Spells of ours for which a `SMSG_SPELL_START` has been seen and the matching GO has not.
   *
   * Exists only to stop the global cooldown being stamped twice for one cast -- once at START and again
   * at GO. See `handleSpellStart` and `handleSpellGo`. Cleared on GO, and on a failure/interrupt, so a
   * cast that never completes cannot leave an id in here and suppress the next instant's GCD.
   */
  private castStarted = new Set<number>();

  /**
   * THE POSE CURRENTLY HELD, per caster guid: which spell armed it and which clip it is.
   *
   * Needed because releasing the held cast pose is only safe when BOTH halves match, and self-review found
   * that neither alone is enough:
   *
   *  - **the spell must be the one in flight.** Any second spell pressed during a 1.5 s cast is refused with
   *    `SMSG_CAST_FAILED`, and keying the release off the refused spell's own DBC row released the pose the
   *    FIRST cast was still holding -- reintroducing the very symptom the pose exists to fix.
   *  - **the clip must still be the latched one.** Two spells can share a pose (`ReadySpellOmni` is the
   *    precast of 879 visuals), and more sharply, a caster who DIES mid-cast has `DEATH` latched instead --
   *    which must never be released from outside or the corpse stands up.
   *
   * Keyed by guid, not a single field: a peer's cast and ours can be in flight at the same time. Cleared at
   * GO, at a failure, and at an interrupt, so it holds at most one entry per actively-casting unit.
   */
  private castPose = new Map<string, { spellId: number; animId: number }>();

  constructor(gameHandler: GameHandler) {
    super();
    this.game = gameHandler;
    this.game.on('packet:receive:SMSG_INITIAL_SPELLS', this.handleInitialSpells.bind(this));
    this.game.on('packet:receive:SMSG_ACTION_BUTTONS', this.handleActionButtons.bind(this));
    this.game.on('packet:receive:SMSG_SPELL_START', this.handleSpellStart.bind(this));
    this.game.on('packet:receive:SMSG_SPELL_GO', this.handleSpellGo.bind(this));
    this.game.on('packet:receive:SMSG_CAST_FAILED', this.handleCastFailed.bind(this));
    this.game.on('packet:receive:SMSG_SPELL_COOLDOWN', this.handleSpellCooldown.bind(this));
    this.game.on('packet:receive:SMSG_COOLDOWN_EVENT', this.handleCooldownEvent.bind(this));
    this.game.on('packet:receive:SMSG_CLEAR_COOLDOWN', this.handleClearCooldown.bind(this));
    this.game.on('packet:receive:SMSG_SPELL_FAILURE', this.handleSpellFailure.bind(this));
    this.game.on('packet:receive:SMSG_SPELL_DELAYED', this.handleSpellDelayed.bind(this));
  }

  /**
   * `SMSG_SPELL_DELAYED` (0x1E2): CAST PUSHBACK. Being hit while casting delays the cast, and **the
   * server tells us by how much** -- this is not a rule the client applies for itself.
   *
   * That is the answer to "is pushback local or on the wire", and the wire is what settles it: the opcode
   * exists in 3.3.5a's own enum, it is sent unprompted, and the 3.3.5a client's own FrameXML has a handler
   * waiting for it -- `CastingBarFrame_OnLoad` registers `UNIT_SPELLCAST_DELAYED`
   * (`castingbarframe.lua:10`) and its branch at `castingbarframe.lua:163-175` RE-READS
   * `UnitCastingInfo(unit)` and recomputes `self.value` and `self.maxValue` from the new `startTime` and
   * `endTime`. A client computing a delay locally would have no reason to re-read a snapshot it had just
   * written, and no reason for a dedicated event at all. There is nothing client-side to derive a delay
   * FROM either: the pushback amount depends on the school, the damage, the caster's talents and
   * resilience and how many pushbacks this cast has already taken, none of which is on the client.
   *
   * 3.3.5a body: `pguid caster`, `u32 delayMs`. Self-checking on the `combatWire` principle -- a delay
   * outside a plausible range means the layout is wrong, and it is recorded rather than applied.
   *
   * **The ANIMATION needs nothing here and that is by construction, not an omission.** The held pose is a
   * loop armed at START and the release is armed at GO, which for a CAST is when the server says it
   * completed -- so a delayed cast holds its pose longer and releases later with no arithmetic on our side.
   * Pushback moves the bar; the animation was already following the server.
   *
   * **NOT true for a CHANNEL, and that is a named gap rather than an oversight.** A channelled spell sends
   * START then GO immediately and then `MSG_CHANNEL_START` (0x139), so the pose is armed and released within
   * a frame or two and the caster stands still for the whole channel, where the real client holds
   * `ChannelCastDirected`/`ChannelCastOmni` (131 and 63 occurrences in `castKitID`). Closing it needs the
   * channel opcodes decoded, which is the same missing feed `lua/api/casting.ts` declares for the bar.
   */
  private handleSpellDelayed(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;
    let caster = '0x0';
    let delayMs = 0;
    try {
      caster = gp.readPackedGUID();
      delayMs = gp.readUnsignedInt();
    } catch (error) {
      spellWire.record({
        at: Date.now(),
        kind: 'SPELL_DELAYED',
        spellId: 0,
        caster: null,
        detail: { error: String(error) },
        bodySize,
        consumed: gp.index - gp.headerSize,
      });
      return;
    }
    // A pushback in 3.3.5a is 500 ms per hit, halved by each Spell Focus rank and reduced by resilience,
    // and the server caps the total at the cast's own length -- so a single packet's value is small. The
    // bound is generous rather than tight (it is a layout check, not a game rule): anything at or beyond
    // a minute is a misaligned read, most likely a guid whose packed length we got wrong.
    const plausible = delayMs > 0 && delayMs < 60000;
    spellWire.record({
      at: Date.now(),
      kind: 'SPELL_DELAYED',
      spellId: 0,
      caster,
      detail: { delayMs, plausible: plausible ? 1 : 0 },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    if (!plausible) {
      console.warn(
        `SPELL_DELAYED: delayMs ${delayMs} is not a plausible cast pushback -- the layout is probably wrong`,
      );
      return;
    }
    this.emit('spellDelayed', { caster, delayMs });
  }

  /**
   * `SMSG_SPELL_FAILURE` (0x133): a cast that had already STARTED was stopped.
   *
   * The distinct opcode matters and is why an interrupt is not inferred from silence, which is what the
   * cast bar would otherwise have to do. `SMSG_CAST_FAILED` (0x130) is the server REFUSING a cast up
   * front -- it never began, and the bar was never shown. This one is a cast that was running and was
   * broken: a stun, a knockback, moving while casting. `CastingBarFrame` distinguishes them, turning red
   * with `FAILED` for one and `INTERRUPTED` for the other (`castingbarframe.lua:139-160`).
   *
   * 3.3.5a body: `pguid caster`, `u8 castCount`, `u32 spellId`, `u8 result`.
   */
  private handleSpellFailure(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;
    let caster = '0x0';
    let spellId = 0;
    try {
      caster = gp.readPackedGUID();
      gp.readUnsignedByte();
      spellId = gp.readUnsignedInt();
    } catch (error) {
      return;
    }
    spellWire.record({
      at: Date.now(),
      kind: 'SPELL_FAILURE',
      spellId,
      caster,
      detail: { name: spellData.spell(spellId)?.name ?? null },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    // A cast that broke never reaches GO, so its id must be dropped here or it would suppress the
    // global cooldown of the next INSTANT cast of the same spell (see `castStarted`).
    this.castStarted.delete(spellId);
    // AND the held pose must be given up, or the caster stands in it for the rest of the session: the pose
    // is a LOOP and `externalSeq`'s release "never releases a loop" by design. GO is what normally takes
    // the latch back, and a broken cast never gets there. Gated on this spell having armed a pose so a
    // failure cannot drop a latch belonging to something else.
    this.releaseCastPose(caster, spellId);
    this.emit('spellFailure', { caster, spellId });
  }

  /**
   * Hand the body back after a cast that will never reach `SMSG_SPELL_GO`.
   *
   * The held pose armed at START is a LOOP, and `Unit#externalSeq`'s release never fires for a loop -- that
   * is what holds the pose, and it is also why a cancelled cast needs an explicit way out. Without this an
   * interrupted caster stands in his cast pose until something else arms an animation, which for a unit
   * standing still is never.
   *
   * TWO GUARDS, and the first version had neither -- it asked `precastAnimationFor` whether the failing
   * spell HAS a pose, which is a DBC question and not a question about this unit at this moment. See
   * `castPose` for the two live failures that found:
   *
   *  1. the recorded in-flight cast must be THIS spell, or a second spell's refusal drops the first cast's
   *     pose mid-cast;
   *  2. `Unit#releaseAnimationLatch` must find that clip still latched, or a caster who died mid-cast has
   *     his `DEATH` latch dropped and the corpse stands up.
   *
   * A no-op is the common and correct outcome: most refusals concern a spell that never started.
   */
  private releaseCastPose(casterGuid: string, spellId: number): void {
    const pose = this.castPose.get(casterGuid);
    if (pose === undefined || pose.spellId !== spellId) {
      return;
    }
    this.castPose.delete(casterGuid);
    this.game.world.entities.get(casterGuid)?.releaseAnimationLatch(pose.animId);
  }

  /** `GetActionCooldown`'s two numbers for one spell, or null when nothing is running. */
  cooldownOf(spellId: number): { start: number; duration: number } | null {
    const entry = this.cooldowns.get(spellId);
    if (entry === undefined) {
      return null;
    }
    if (entry.start + entry.duration <= gameTime()) {
      this.cooldowns.delete(spellId);
      return null;
    }
    return entry;
  }

  /**
   * Record a cooldown. `durationMs` of 0 or less CLEARS, which is what `SMSG_CLEAR_COOLDOWN` means.
   *
   * A SHORTER cooldown never replaces a longer one that is still running: a global cooldown landing on a
   * spell that is on a 30-second cooldown of its own must not cut it to 1.5 s. The real client keeps the
   * later expiry for exactly this reason -- every cast puts the GCD on every spell on the bar.
   */
  private setCooldown(spellId: number, durationMs: number, startAt = gameTime()): boolean {
    if (spellId <= 0) {
      return false;
    }
    if (durationMs <= 0) {
      return this.cooldowns.delete(spellId);
    }
    const duration = durationMs / 1000;
    const existing = this.cooldowns.get(spellId);
    if (existing !== undefined && existing.start + existing.duration > startAt + duration) {
      return false;
    }
    this.cooldowns.set(spellId, { start: startAt, duration });
    return true;
  }

  /** Drop entries whose expiry has passed, so a long session's map stays the size of the live set. */
  private pruneCooldowns(): void {
    const now = gameTime();
    for (const [spellId, entry] of this.cooldowns) {
      if (entry.start + entry.duration <= now) {
        this.cooldowns.delete(spellId);
      }
    }
  }

  /**
   * THE GLOBAL COOLDOWN, applied on our own confirmed cast.
   *
   * Applied at `SMSG_SPELL_GO` and not at the click, deliberately: a cast the server refuses
   * (`SMSG_CAST_FAILED`) triggers no GCD in the real client, and `Gesf` -- who is refused every cast --
   * would otherwise show a full bar of sweeps for a cast that never happened. GO is the server's
   * confirmation, and it is also where this file already arms the caster's animation.
   *
   * The GCD goes on every KNOWN spell sharing the category, which is the client's rule and is why the
   * whole bar dims at once. Spells not known are skipped -- they cannot be on a button.
   */
  private applyGlobalCooldown(spellId: number): boolean {
    const cast = spellData.spell(spellId);
    if (cast === null || cast.startRecoveryCategory === 0 || cast.startRecoveryTimeMs <= 0) {
      // Off-GCD, and correctly so for Heroic Strike (78) and Auto Attack (6603) -- both read category 0
      // and time 0 on the served file. `spellData` being absent also lands here, which is honest: with
      // no table there is no GCD to compute and the bar simply shows none.
      return false;
    }
    const at = gameTime();
    let changed = false;
    for (const known of this.known) {
      const row = spellData.spell(known);
      if (row === null || row.startRecoveryCategory !== cast.startRecoveryCategory) {
        continue;
      }
      if (this.setCooldown(known, cast.startRecoveryTimeMs, at)) {
        changed = true;
      }
    }
    // The cast spell's OWN cooldown, from the DBC, for the same reason: the server does not send a packet
    // for a cooldown the client can derive from its own tables.
    if (cast.recoveryTimeMs > 0 && this.setCooldown(spellId, cast.recoveryTimeMs, at)) {
      changed = true;
    }
    if (cast.categoryRecoveryTimeMs > 0 && cast.category !== 0) {
      for (const known of this.known) {
        const row = spellData.spell(known);
        if (row === null || row.category !== cast.category) {
          continue;
        }
        if (this.setCooldown(known, cast.categoryRecoveryTimeMs, at)) {
          changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * `SMSG_SPELL_COOLDOWN` (0x134): the server's own cooldown list for a unit.
   *
   * 3.3.5a body: `u64 guid`, `u8 flags`, then `{ u32 spellId, u32 cooldownMs }` repeated to the end of
   * the body. Only OUR OWN guid matters -- a pet's or another unit's cooldowns are not on our bar.
   */
  private handleSpellCooldown(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;
    const guid = gp.readGUID();
    gp.readUnsignedByte();
    let changed = false;
    const pairs: Array<[number, number]> = [];
    while (gp.available >= 8) {
      const spellId = gp.readUnsignedInt();
      const ms = gp.readUnsignedInt();
      pairs.push([spellId, ms]);
      if (this.setCooldown(spellId, ms)) {
        changed = true;
      }
    }
    spellWire.record({
      at: Date.now(),
      kind: 'SPELL_COOLDOWN',
      spellId: pairs[0]?.[0] ?? 0,
      caster: String(guid),
      detail: {
        count: pairs.length,
        firstSpell: pairs[0]?.[0] ?? null,
        firstMs: pairs[0]?.[1] ?? null,
      },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    if (changed) {
      this.announceCooldowns();
    }
  }

  /**
   * `SMSG_COOLDOWN_EVENT` (0x135): one spell's cooldown STARTED, with no duration in the packet.
   *
   * 3.3.5a body: `u32 spellId`, `u64 guid`. The duration is the client's own to look up, which is why
   * `Spell.dbc`'s `RecoveryTime` is read here rather than waited for on the wire.
   */
  private handleCooldownEvent(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;
    const spellId = gp.readUnsignedInt();
    const guid = gp.readGUID();
    const row = spellData.spell(spellId);
    const ms = row?.recoveryTimeMs ?? 0;
    spellWire.record({
      at: Date.now(),
      kind: 'COOLDOWN_EVENT',
      spellId,
      caster: String(guid),
      detail: { recoveryTimeMs: ms, name: row?.name ?? null },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    if (ms > 0 && this.setCooldown(spellId, ms)) {
      this.announceCooldowns();
    }
  }

  /** `SMSG_CLEAR_COOLDOWN` (0x1DE): `u32 spellId`, `u64 guid`. The cooldown is over early. */
  private handleClearCooldown(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const spellId = gp.readUnsignedInt();
    if (this.cooldowns.delete(spellId)) {
      this.announceCooldowns();
    }
  }

  private announceCooldowns(): void {
    this.pruneCooldowns();
    this.emit('cooldownsChanged');
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
   * `SMSG_SPELL_START` (0x131): a cast BEGAN. **This is what drives the cast bar.**
   *
   * **AND IT ARMS THE HELD CAST POSE.** This comment used to say the animation "is still armed at SPELL_GO
   * rather than here"; that was true for two rounds and is the half that was wrong. GO is the END of a cast,
   * so the clip armed there is the RELEASE -- which is what the reference's rule names. The pose that runs
   * FOR the cast is `SpellVisual.dbc`'s `precastKitID` and is armed below. See `spell-anim.ts`.
   *
   * **A correction to `STATE.md`, which said the cast duration "IS decoded and emitted".** It was not.
   * `readCastHead` stopped after `castFlags` and never read the trailing `u32`, so `spellStart` carried
   * no duration at all and a cast bar had nothing to size itself from. That word is the cast length in
   * milliseconds -- ONE word, not two; see `readCastHead` for the measurement that settled the count.
   *
   * The wire's number is a better source than `Spell.dbc`'s `CastingTimeIndex`, and is why that table is
   * not read: the server's value already has haste, talents and every aura folded into it, where the DBC
   * carries only the unmodified base. Measured for Healing Wave (331) on a level-70 shaman: **1500 ms**.
   */
  private handleSpellStart(gp: GamePacket): void {
    const decoded = this.readCastHead(gp, 'SPELL_START');
    if (decoded === null) {
      return;
    }
    // THE GLOBAL COOLDOWN STARTS HERE for a spell with a cast time, not at GO -- and this was measured
    // wrong the first way round. Applying it only at GO put the sweep AFTER the 1.5 s cast instead of
    // during it: sampled live, the cast bar filled from t=300 ms to t=1700 ms and the three sweeps
    // appeared at t=1698 ms, which is the moment the cast ENDED. The real client runs the bar and the
    // global cooldown together.
    //
    // START is a safe trigger for the same reason GO was chosen originally: the server only sends it for
    // a cast it has ACCEPTED. A refused cast gets `SMSG_CAST_FAILED` and no START -- which is what makes
    // this correct for `Gesf`, whose every cast is refused and who must show no sweep at all.
    //
    // `castStarted` then suppresses the GO-time application, or the same cast would stamp the cooldown
    // twice and the second stamp -- being later -- would win and double the GCD.
    if (decoded.caster === this.game.world.player?.guid) {
      this.castStarted.add(decoded.spellId);
      if (this.applyGlobalCooldown(decoded.spellId)) {
        this.announceCooldowns();
      }
    }

    // THE HELD CAST POSE. This is the half that was missing, and it is why the owner saw "no animation
    // during the cast, only the final part". The clip armed at GO is `castKitID`'s, and GO is the moment
    // the cast ENDS -- so a 1.5 s Healing Wave stood still for 1.5 s and then discharged. The pose comes
    // from `SpellVisual.dbc`'s OTHER kit column, `precastKitID`; see `spell-anim.ts` for which field is
    // which and how that was measured.
    //
    // For ANY caster, not just ourselves -- a peer casting beside us holds the same pose, exactly as
    // `handleSpellGo` already arms a peer's release. Same plain `entities` lookup the swing uses.
    //
    // `interrupt` true and `repetitions` -1: the pose is a LOOP (`ReadySpellOmni`/`ReadySpellDirected`),
    // and `Unit#externalSeq`'s latch never releases a loop, which is what HOLDS it. The release armed at
    // GO replaces the latch; `releaseAnimationLatch` below is the way out when the cast never gets there.
    const caster = this.game.world.entities.get(decoded.caster);
    if (caster) {
      const pose = precastAnimationFor(caster, decoded.spellId);
      if (pose !== null) {
        caster.setAnimation(pose, true, -1);
        // RECORDED so a later failure can tell this pose from any other latch -- see `castPose`.
        this.castPose.set(decoded.caster, { spellId: decoded.spellId, animId: pose });
      }
    }

    this.emit('spellStart', decoded);
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

    // THE RELEASE. `castKitID`'s clip, armed here at GO -- which is the reference's rule
    // (`SpellCastOmni` at SPELL_GO) and is correct for what it names: GO is the completion of the cast.
    // What was WRONG for two rounds is that this was the ONLY clip; the held pose that runs for the cast's
    // duration is `precastKitID`'s and is armed at START. See `spell-anim.ts`.
    //
    // The caster may be a peer as easily as ourselves, so this is the same plain `entities` lookup the
    // swing and the defense reaction use in `combat.ts`.
    const unit = this.game.world.entities.get(decoded.caster);
    if (unit) {
      const anim = castAnimationFor(unit, decoded.spellId);
      if (anim !== null) {
        // A ONE-SHOT (repetitions 0) with `interrupt` true, exactly as a swing is armed. Arming it is also
        // what RELEASES the held pose: `startAnimation` re-latches `externalSeq` onto whatever it just
        // armed, and a one-shot's latch gives the body back to locomotion when the clip's window ends. So
        // pose -> release -> stand needs no bookkeeping, and the blend layer makes both edges a fade.
        unit.setAnimation(anim, true, 0);
      } else {
        // NO release clip. If this spell armed a pose, nothing else would ever take the latch off it -- a
        // LOOP has no window to elapse -- so the caster would hold it for good. Through `releaseCastPose`
        // rather than a bare release, so both identity guards apply here too.
        this.releaseCastPose(decoded.caster, decoded.spellId);
      }
      // The release clip re-latched `externalSeq` onto itself, so the pose record is spent either way.
      this.castPose.delete(decoded.caster);
    }

    // THE GLOBAL COOLDOWN for an INSTANT spell, which is the only kind that reaches here without having
    // been stamped already. An instant sends no `SMSG_SPELL_START` at all -- so `castStarted` is empty for
    // it and this is its one chance -- while a timed cast was stamped at START and is skipped here, or the
    // later stamp would win and double the GCD. `world.player` is the authority on which guid is ours; a
    // peer's confirmed cast must not put a cooldown on our bar.
    if (decoded.caster === this.game.world.player?.guid) {
      if (this.castStarted.delete(decoded.spellId)) {
        // Timed cast: already stamped at START. Nothing to do.
      } else if (this.applyGlobalCooldown(decoded.spellId)) {
        this.announceCooldowns();
      }
    }

    this.emit('spellGo', decoded);
  }

  /**
   * The shared head of `SMSG_SPELL_START` and `SMSG_SPELL_GO`.
   *
   * `pguid item-or-caster`, `pguid caster`, `u8 castCount`, `u32 spellId`, `u32 castFlags`, then on START
   * `u32 timer` (ms remaining) and `u32 castTime` (the full length) and on GO one `u32 getMSTime()`. The
   * first guid is the CAST ITEM's when one is in play and the caster's own otherwise; the second is always
   * the casting unit, so the second is the one to animate (`spells.rs:143-146`).
   *
   * SELF-CHECKING, on the `combatWire` principle: a `spellId` of 0, or one absurdly out of range, means
   * the layout is wrong -- most likely the reference's 1.12 form, which lands the id one byte early. The
   * decode returns null and records the failure rather than arming an animation from garbage.
   */
  private readCastHead(
    gp: GamePacket,
    kind: 'SPELL_START' | 'SPELL_GO',
  ): { caster: string; spellId: number; castFlags: number; timerMs: number; castTimeMs: number } | null {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;

    let caster = '0x0';
    let spellId = 0;
    let castFlags = 0;
    let timerMs = 0;
    let castTimeMs = 0;
    try {
      gp.readPackedGUID();
      caster = gp.readPackedGUID();
      gp.readUnsignedByte();
      spellId = gp.readUnsignedInt();
      castFlags = gp.readUnsignedInt();
      // THE WORD THE CAST BAR NEEDS, which was described in this comment for two rounds and never read.
      // ONE `u32`, and that count is MEASURED rather than taken from a server source.
      //
      // The first attempt at this read two words -- `m_timer` then `m_casttime`, which is the shape
      // TrinityCore's `SendSpellStart` suggests -- and the live wire refuted it immediately. For a
      // shaman's Healing Wave (331) the two words came back **1500 and 2**. If both fields existed they
      // would both be 1500 (`m_timer` is initialised to `m_casttime` when a cast is prepared), and 2 is
      // exactly `TARGET_FLAG_UNIT`, the first word of the `SpellCastTargets` block that follows. So
      // there is one `u32` here and the next thing on the wire is the target mask.
      //
      // Corroborated on `SPELL_GO` for the same cast, where the single word read **18448130** -- a
      // `getMSTime()` millisecond counter, not a duration, which is what the reference says GO carries.
      //
      // At the START of a cast the remaining time and the full length are the same number, so this one
      // word serves as both: `castTimeMs` is the bar's length and `timerMs` the part still to run. A
      // `SMSG_SPELL_START` for a cast ALREADY IN PROGRESS (entering the world beside a casting unit)
      // would carry only the remainder and would draw a bar that is too short -- named here rather than
      // guessed at, because nothing in this client can currently observe that case.
      if (gp.available >= 4) {
        timerMs = gp.readUnsignedInt();
        if (kind === 'SPELL_START') {
          castTimeMs = timerMs;
        }
      }
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
        timerMs,
        castTimeMs,
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
    return {
      caster, spellId, castFlags, timerMs, castTimeMs,
    };
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
    // Same reason as in `handleSpellFailure`: a refused cast never reaches GO, so its id must not be left
    // in `castStarted` to suppress a later instant's global cooldown.
    this.castStarted.delete(spellId);
    // `SMSG_CAST_FAILED`'s body names no caster -- the server only refuses OUR casts -- so the pose to
    // release is the player's. Ordinarily there is none to release: a refused cast gets no START either,
    // so no pose was ever armed. The case this covers is a cast that STARTED and was then refused.
    const self = this.game.world.player?.guid;
    if (self !== undefined) {
      this.releaseCastPose(self, spellId);
    }
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

  /**
   * The spell in a slot, or null when the slot is empty or holds a macro/item/companion.
   *
   * A slot holding something this client cannot act on is NAMED once rather than silently skipped -- a
   * macro or an item on the bar would otherwise be indistinguishable from an empty slot, and a button
   * that is empty for a reason nobody stated is how a screen renders plausibly and wrongly.
   */
  spellInSlot(action: number): number | null {
    const slot = this.slot(action);
    if (slot === null || slot.action === 0) {
      return null;
    }
    if (slot.type !== ACTION_BUTTON_SPELL) {
      const key = `${slot.type}`;
      if (!this.warnedTypes.has(key)) {
        this.warnedTypes.add(key);
        console.warn(
          `action bar: slot ${action} holds a ${SpellHandler.typeName(slot.type)}, which this client `
          + 'cannot show or use -- only ACTION_BUTTON_SPELL is handled. The button stays empty.',
        );
      }
      return null;
    }
    return slot.action;
  }

  /** One warning per unsupported slot TYPE, not per slot -- a full macro bar would print twelve. */
  private warnedTypes = new Set<string>();

  knownSpells(): ReadonlySet<number> {
    return this.known;
  }

  /**
   * `CMSG_SET_ACTION_BUTTON` (**0x128**): TELL THE SERVER an action slot changed.
   *
   * This is what stops a rearranged bar reverting on relog, and it is the outbound half of the drag work:
   * moving an ability is a real change to the character, not a client-side display choice.
   *
   * **Body: `u8 slot` + `u32 packedData`**, 5 bytes. The slot is **0-BASED** -- the same indexing
   * `SMSG_ACTION_BUTTONS` uses for its 144-word array -- so a 1-based Lua action becomes `action - 1`
   * here, at the one place that conversion happens for the outbound direction (`slot()` is the inbound one).
   * `packedData` is `(type << 24) | (action & 0x00FFFFFF)`, the identical packing `handleActionButtons`
   * decodes, and **`packedData == 0` is the REMOVE form** -- the server drops the button rather than
   * storing an empty one.
   *
   * ## What is evidence and what is not, stated plainly
   *
   * The PACKING is corroborated in this client: `handleActionButtons` reads exactly this layout out of
   * `SMSG_ACTION_BUTTONS`, and it was confirmed against a real 577-byte body whose five filled words
   * decoded to sensible spells at the slots `SpellShapeshiftForm.dbc` independently predicted. So the word
   * format is measured, not guessed.
   *
   * The `u8 slot` PREFIX is not: it comes from the server implementations this build's protocol is shared
   * with (TrinityCore 3.3.5's `WorldSession::HandleSetActionButtonOpcode` reads `uint8 button` then
   * `uint32 packetData` and treats a zero payload as a removal; vmangos is the same), and this client has
   * no capture of the opcode being sent. **It is verified only to the extent that the round trip works** --
   * the server answers a correct write by storing it, which shows up as the bar surviving a relog. A wrong
   * prefix width would put the action in the wrong slot or be rejected outright, so the failure is visible
   * rather than silent, which is why sending it is better than leaving the move client-only.
   *
   * `>>> 0` on the packed word for the reason `handleActionButtons` uses `>>> 24`: a type byte of 0x80
   * makes the value exceed 2^31, and `writeUnsignedInt` must be handed an unsigned number.
   */
  setActionButton(action: number, spellId: number | null): void {
    if (!Number.isFinite(action) || action < 1 || action > MAX_ACTION_BUTTONS) {
      return;
    }
    // `packedData` 0 is the server's REMOVE form; a spell keeps type `ACTION_BUTTON_SPELL` (0x00), so the
    // packed word for a spell is just its id.
    const packed = spellId === null || spellId === 0
      ? 0
      : (((ACTION_BUTTON_SPELL << 24) | (spellId & ACTION_MASK)) >>> 0);

    const app = new GamePacket(GameOpcode.CMSG_SET_ACTION_BUTTON, GamePacket.HEADER_SIZE_OUTGOING + 1 + 4);
    app.writeUnsignedByte(action - 1);
    app.writeUnsignedInt(packed);
    this.game.send(app);

    // The LOCAL slot is updated too, and it must be: `SMSG_ACTION_BUTTONS` is sent once at login and the
    // server sends no acknowledgement for this opcode, so nothing would ever tell the bar what it now
    // holds. The array is grown if the login packet was short (a non-zero `packetType` can carry no
    // slots), so a write cannot land on a hole.
    while (this.slots.length < MAX_ACTION_BUTTONS) {
      this.slots.push({ action: 0, type: ACTION_BUTTON_SPELL });
    }
    this.slots[action - 1] = {
      action: spellId ?? 0,
      type: ACTION_BUTTON_SPELL,
    };

    spellWire.record({
      at: Date.now(),
      kind: 'SET_ACTION_BUTTON',
      spellId: spellId ?? 0,
      caster: null,
      detail: {
        slot: action,
        wireSlot: action - 1,
        packed,
        name: spellId === null ? null : (spellData.spell(spellId)?.name ?? null),
      },
      bodySize: 5,
      consumed: 5,
    });
  }

  /**
   * Move an action from one slot to another, SWAPPING with whatever is already in the destination.
   *
   * A swap and not an overwrite, because that is what the real client does with a bar-to-bar drag: the
   * displaced ability lands where the dragged one came from rather than being destroyed. Two packets, one
   * per slot, because the opcode addresses a single button -- there is no swap opcode.
   *
   * `actionsChanged` is emitted ONCE, after both writes, so `action-bridge.ts#pushAll` sees a consistent
   * pair. Emitting per write would hand the UI a moment in which the same ability was in both slots.
   */
  moveActionButton(from: number, to: number): void {
    if (from === to) {
      return;
    }
    const source = this.spellInSlot(from);
    const destination = this.spellInSlot(to);
    if (source === null) {
      return;
    }
    this.setActionButton(to, source);
    this.setActionButton(from, destination);
    this.emit('actionsChanged');
  }

  /** Put a spell into a slot, replacing whatever was there. The spellbook-to-bar drag. */
  assignActionButton(action: number, spellId: number): void {
    this.setActionButton(action, spellId);
    this.emit('actionsChanged');
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
