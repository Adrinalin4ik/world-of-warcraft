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
import { GUID_BYTES, guidBytes, guidHex } from '../../guid-hex';
import { castAnimationFor, precastAnimationFor } from '../../../game/classes/spell-anim';
import { spellData } from '../../../game/pipeline/dbc/spell-data';
import { spellWire } from '../../../game/classes/spell-wire';
import PendingCast from '../../../game/classes/pending-cast';
import { ERR_NO_TARGET, resolveCastTarget } from '../../../game/classes/cast-target';
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

/**
 * `SMSG_SPELL_GO`'s decoded target tail. See `SpellHandler#readSpellGoTargets` for the layout, the
 * two width deltas and why `plausible` exists.
 */
export interface SpellGoTargets {
  /** Units the cast LANDED on -- one missile each, and the impact kit plays on each. */
  hits: string[];
  /** Units it missed, with the wire's `SpellMissInfo`. A missile still flies at a missed target. */
  misses: Array<{ guid: string; condition: number }>;
  targetMask: number;
  /** The ground point, when the mask carries one -- the location fallback's single projectile. */
  dest: { x: number; y: number; z: number } | null;
  /** False when the stride check failed or the body was short: treat the lists as unusable. */
  plausible: boolean;
}

/**
 * One live cooldown. `start` and `duration` are `GetTime()` SECONDS -- the shape
 * `GetActionCooldown` and `GetSpellCooldown` return and `CooldownFrame_SetTimer` consumes.
 *
 * `fromGcd` is PROVENANCE, and it exists so a cancelled cast can give back the global cooldown
 * without touching a real one. See `clearGlobalCooldown`.
 */
interface CooldownEntry {
  start: number;
  duration: number;
  fromGcd: boolean;
}

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
  private cooldowns = new Map<number, CooldownEntry>();

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

  /**
   * OUR OWN OUTSTANDING CAST -- the optimistic in-flight guard that makes a second press of a spell
   * mid-cast a no-op instead of a cast-bar kill. See `game/classes/pending-cast.ts` for the whole
   * mechanism, the reference citations and the bug it closes.
   *
   * Lives here because this is the one class that both SENDS the cast and receives every packet that
   * resolves it, which is what keeps the arm and the clear from drifting apart -- the reference's
   * "ONE cast-send path" rule (`ui_action/cast_send.rs:216-218`).
   */
  private pendingCast = new PendingCast();

  /**
   * The last `SMSG_UPDATE_COMBO_POINTS`: how many points, and WHICH unit they are banked against.
   *
   * PUBLIC because `unit-bridge.ts` has to compare `target` with what the player is looking at --
   * `GetComboPoints` is a question about a pair, and the pair is only knowable where both guids are.
   * See `handleComboPoints`.
   */
  public comboState: { points: number; target: string | null } = { points: 0, target: null };

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
    this.game.on('packet:receive:SMSG_UPDATE_COMBO_POINTS', this.handleComboPoints.bind(this));
    // THE THREE INCREMENTAL SPELL EDGES, and all three had NO SUBSCRIBER AT ALL until the trainer
    // round. `SMSG_INITIAL_SPELLS` is a login-burst snapshot, so without these a spell learned DURING
    // a session -- from a trainer, from a quest reward, from a level-up -- was known to the server and
    // absent from `this.known` until the next relog. See `handleLearnedSpell`.
    this.game.on('packet:receive:SMSG_LEARNED_SPELL', this.handleLearnedSpell.bind(this));
    this.game.on('packet:receive:SMSG_SUPERCEDED_SPELL', this.handleSupercededSpell.bind(this));
    this.game.on('packet:receive:SMSG_REMOVED_SPELL', this.handleRemovedSpell.bind(this));
  }

  /**
   * `SMSG_LEARNED_SPELL` (**0x12B**): `u32 spellId · u16 unk`, 6 bytes.
   *
   * The layout is TrinityCore 3.3.5's `Player::SendLearnPacket` shape and is labelled as a server-side
   * source, exactly as `handleComboPoints` labels its own. The trailing `u16` is written as a literal 0
   * and its meaning is unstated there, so it is read for the residual and discarded.
   *
   * **The residual is the whole check on all three of these arms**: 6 bytes for this one, 8 for
   * superceded, 4 for removed. A wrong layout would show as a nonzero remainder in
   * `window.spellWire.history()` rather than as a spell quietly missing from the book.
   *
   * `spellsChanged` is emitted only when the set actually CHANGED. The server can and does re-send a
   * spell the client already has (a rank refresh, a talent reset replay), and `spellbook-bridge.ts#push`
   * rebuilds and re-sorts the whole book off this event -- so an unconditional emit would pay that walk
   * for nothing and dirty the interface fingerprint with it.
   */
  private handleLearnedSpell(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;
    const spellId = gp.readUnsignedInt() >>> 0;
    if (gp.available >= 2) {
      gp.readUnsignedShort(); // unk -- a literal 0 server-side; read so `consumed` is meaningful
    }
    const isNew = spellId !== 0 && !this.known.has(spellId);
    if (isNew) {
      this.known.add(spellId);
    }
    spellWire.record({
      at: Date.now(),
      kind: 'LEARNED_SPELL',
      spellId,
      caster: null,
      detail: { known: this.known.size, isNew: isNew ? 1 : 0 },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    if (isNew) {
      this.emit('spellsChanged');
    }
  }

  /**
   * `SMSG_SUPERCEDED_SPELL` (**0x12C**): `u32 newSpellId · u32 oldSpellId`, 8 bytes.
   *
   * A RANK UP -- what a trainer teaching Rank 2 of an ability sends instead of a plain learn. The old
   * rank leaves the book as the new one enters, which is why this is one packet and not two: handling
   * only the learn half would leave both ranks in the spellbook and two buttons that cast the same
   * ability.
   *
   * Order is `new` then `old`, TrinityCore 3.3.5's `Player::SendSupercededSpell`. It is the one field
   * order here that a residual CANNOT check -- both words are `u32` and either order consumes the body
   * whole -- so it is called out rather than presented as measured. The consequence of having it
   * backwards is visible immediately and harmlessly: the spellbook would show the OLD rank and lose the
   * new one, which the owner would see on the first rank-up.
   */
  private handleSupercededSpell(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;
    const newSpellId = gp.readUnsignedInt() >>> 0;
    const oldSpellId = gp.readUnsignedInt() >>> 0;
    let changed = false;
    if (oldSpellId !== 0 && this.known.delete(oldSpellId)) {
      changed = true;
    }
    if (newSpellId !== 0 && !this.known.has(newSpellId)) {
      this.known.add(newSpellId);
      changed = true;
    }
    spellWire.record({
      at: Date.now(),
      kind: 'SUPERCEDED_SPELL',
      spellId: newSpellId,
      caster: null,
      detail: { oldSpellId, known: this.known.size },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    if (changed) {
      this.emit('spellsChanged');
    }
  }

  /**
   * `SMSG_REMOVED_SPELL` (**0x203**): `u32 spellId`, 4 bytes.
   *
   * The unlearn edge -- a talent reset, or a profession abandoned. Wired with its two siblings because
   * leaving it out would let the book keep a spell the server has taken away, which is the same class
   * of staleness the other two fix.
   */
  private handleRemovedSpell(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;
    const spellId = gp.readUnsignedInt() >>> 0;
    const changed = spellId !== 0 && this.known.delete(spellId);
    spellWire.record({
      at: Date.now(),
      kind: 'REMOVED_SPELL',
      spellId,
      caster: null,
      detail: { known: this.known.size },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    if (changed) {
      this.emit('spellsChanged');
    }
  }

  /**
   * `SMSG_UPDATE_COMBO_POINTS` (**0x39D**): where combo points come from, and the answer is that they
   * come on their own opcode and nowhere else.
   *
   * Established by ELIMINATION as much as by reading: there is no `UNIT_FIELD_COMBO_POINTS` in 3.3.5a's
   * update-field enum (`network/game/object/enums.ts` decodes the whole unit block and has no such
   * field), so a client cannot read them off a snapshot. The opcode was already in `opcode.js:927` --
   * present in the build's own enum -- with **no subscriber at all**, which is exactly the shape
   * `SMSG_SPELL_DELAYED` was in before it was wired.
   *
   * Body: `pguid comboTarget`, `u8 comboPoints`. **The layout is NOT sourced from the client or from a
   * capture** -- it is the server implementations' shape, the same class of evidence as the `u8` slot
   * prefix on `CMSG_SET_ACTION_BUTTON`, and it is labelled here rather than presented as measured.
   * It is SELF-CHECKING on the `combatWire` principle: the body must be consumed WHOLE and the count
   * must be 0..5 (3.3.5a's maximum, and Ruthlessness cannot exceed it), or the packet is recorded and
   * DROPPED rather than believed. If the layout is wrong, `spellWire` says so instead of the combo
   * frame lighting five points for a misread byte.
   *
   * **NOT VERIFIED LIVE, and it cannot be here**: neither test account has a rogue or a druid, and no
   * other class is ever sent this packet. `spellWire` will carry the first real one.
   */
  private handleComboPoints(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;
    let target = '0x0';
    let points = 0;
    try {
      target = gp.readPackedGUID();
      points = gp.readUnsignedByte();
    } catch (error) {
      spellWire.record({
        at: Date.now(),
        kind: 'COMBO_POINTS',
        spellId: 0,
        caster: null,
        detail: { error: String(error) },
        bodySize,
        consumed: gp.index - gp.headerSize,
      });
      return;
    }
    const consumed = gp.index - gp.headerSize;
    const plausible = points <= 5 && consumed === bodySize;
    spellWire.record({
      at: Date.now(),
      kind: 'COMBO_POINTS',
      spellId: 0,
      caster: target,
      detail: { points, plausible: plausible ? 1 : 0 },
      bodySize,
      consumed,
    });
    if (!plausible) {
      console.warn(
        `UPDATE_COMBO_POINTS: ${points} points and ${consumed} of ${bodySize} bytes consumed -- the layout is probably wrong`,
      );
      return;
    }
    // A zero count carries no combo target in the real client's own bookkeeping (the points are gone),
    // so it is normalised to null here and the bridge does not have to special-case a stale guid.
    this.comboState = points === 0 ? { points: 0, target: null } : { points, target };
    this.emit('comboPoints', this.comboState);
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
    // The cast is now longer than START said, so the guard's deadline has to follow it or the guard
    // would lapse mid-cast and let a press through.
    if (caster === this.game.world.player?.guid) {
      this.pendingCast.delay(delayMs, Date.now());
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
    // Our own cast broke: open the guard AND GIVE BACK THE GLOBAL COOLDOWN. A peer's failure is
    // neither our guard's business nor our bar's -- the GCD is ours alone.
    //
    // This is the owner's second report ("если мы кастуем и каст прервался ... то гкд сбрасывается")
    // on the wire-driven edge: a timed cast stamps the GCD at `SMSG_SPELL_START` and, until now,
    // nothing took it back when the cast did not finish. The reference's model is arm-at-send +
    // clear-on-failure (`ui_action/cast_send.rs:643-647`); `clearGlobalCooldown` is that clear, and it
    // drops ONLY `fromGcd` entries so a real cooldown the server started survives the interrupt.
    if (caster === this.game.world.player?.guid) {
      this.pendingCast.clearIf(spellId);
      this.clearGlobalCooldown();
    }
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
   *
   * ## IT ALSO REAPS THE CAST'S KIT EFFECTS, and that is why it is the single exit
   *
   * The precast stage arms two things on the same edge -- a held POSE and a set of persistent emitter
   * MODELS (`world/spell-kit-effects.ts`) -- so both have to end on the same edge too. Every existing
   * way out of a cast already funnels here: `SMSG_SPELL_FAILURE`, `SMSG_CAST_FAILED`, a GO with no
   * release clip, Escape (`ui/target-bridge.ts`) and the movement cancel
   * (`classes/cast-cancel.ts`). Reaping here rather than at those five call sites is what stops a
   * cancelled cast leaving a glow burning on the caster for the rest of the session -- the exact
   * failure mode the pose half already had.
   *
   * The reap is BEFORE the pose guards and not behind them, deliberately: those guards ask whether
   * this spell armed the latch, and a spell can carry kit slots without carrying a pose at all (the
   * kit's anim column is one of twelve). Behind the guard, such a cast would keep its glow for ever.
   * The reap is itself spell-id keyed, so it cannot touch another spell's instances.
   */
  releaseCastPose(casterGuid: string | null, spellId: number): void {
    if (casterGuid === null) {
      return;
    }
    this.game.world.spellKitEffects.reap(casterGuid, spellId);
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
  private setCooldown(
    spellId: number,
    durationMs: number,
    startAt = gameTime(),
    fromGcd = false,
  ): boolean {
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
    this.cooldowns.set(spellId, { start: startAt, duration, fromGcd });
    return true;
  }

  /**
   * **CLEAR THE GLOBAL COOLDOWN, and only it** -- the owner's "если мы кастуем и каст прервался
   * из-за движения или мы сами его отменили как-то, то гкд сбрасывается".
   *
   * The reference states both halves of the real client's model and byte-verifies them: the GCD is
   * armed at SEND (`StartGlobalCooldown 0x6e2de0` from the cast-send arm `0x6e58fb`) and "a later
   * `SMSG_CAST_RESULT` failure clears it again (`0x6e1630`)"
   * (`benilla-app/src/ui_action/cast_send.rs:643-647`). So a cast that does not complete gives the
   * global cooldown back; this is that clear.
   *
   * **`fromGcd` IS THE WHOLE POINT, and without it this would be the wrong fix.** A real cooldown
   * must survive an interrupted cast -- a 2-minute racial whose cooldown the server started is not
   * refunded because a later cast was cancelled -- so the entries have provenance and only the ones
   * the GCD pass wrote are dropped. The two cannot be told apart by DURATION: a 1.5 s spell cooldown
   * exists, and `setCooldown`'s longer-wins rule means a real cooldown that landed on a spell already
   * carrying a GCD has already replaced the entry and cleared the flag with it.
   *
   * Returns whether anything was dropped, so the caller decides whether to announce -- the discarded
   * -return defect class this project records twice.
   */
  clearGlobalCooldown(): boolean {
    let changed = false;
    for (const [spellId, entry] of this.cooldowns) {
      if (entry.fromGcd) {
        this.cooldowns.delete(spellId);
        changed = true;
      }
    }
    if (changed) {
      this.announceCooldowns();
    }
    return changed;
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
   * **ALL THREE COOLDOWNS a confirmed cast of ours starts** -- the global one, the spell's own, and
   * its category's. Renamed from `applyGlobalCooldown`, which named only the first of the three and
   * is why a gate meant for that one was allowed to skip the other two; see leg (1).
   *
   * ## WHEN it is applied, and a STATED DEVIATION from the reference
   *
   * This runs on the server's CONFIRMATION -- `SMSG_SPELL_START` for a timed cast, `SMSG_SPELL_GO`
   * for an instant, with `castStarted` keeping one cast from stamping twice.
   *
   * **The real client does it differently and the previous version of this comment misdescribed
   * it.** It said the GCD is applied at GO rather than at the click because "a cast the server
   * refuses triggers no GCD in the real client". The OUTCOME is right; the mechanism is not. The
   * reference byte-verifies both halves: the client arms the GCD **at send**
   * (`StartGlobalCooldown 0x6e2de0` from the cast-send arm `0x6e58fb`) and "a later
   * `SMSG_CAST_RESULT` failure clears it again (`0x6e1630`)"
   * (`benilla-app/src/ui_action/cast_send.rs:643-647`). So it arms optimistically and gives it back,
   * where we simply never arm.
   *
   * The visible difference is one round trip: the real client's sweep starts on the keypress, ours
   * about 150 ms later when the confirmation lands. Arming at send is left for a scoped round --
   * `clearGlobalCooldown` is the half the owner asked for and is now built, so moving the arm point
   * is a one-line change with the clear already in place. Named rather than quietly kept.
   *
   * The GCD goes on every KNOWN spell sharing the category, which is the client's rule and is why the
   * whole bar dims at once. Spells not known are skipped -- they cannot be on a button.
   */
  private applyCastCooldowns(spellId: number): boolean {
    const cast = spellData.spell(spellId);
    if (cast === null) {
      // No table, so nothing to derive. Honest rather than silent: with `Spell.dbc` absent the bar
      // shows no cooldown at all, and the server's own `SMSG_SPELL_COOLDOWN` still lands if it comes.
      return false;
    }
    const at = gameTime();
    let changed = false;

    // ── (1) THE GLOBAL COOLDOWN, across the GCD category. GATED, and the gate now covers ONLY this
    // loop, which is the whole of the owner's first defect.
    //
    // "у нас не имплементировано общий кулдаун способностей, например если я жму Каждый сам за себя,
    // у меня не появляется кд, хотя должно быть 2 минуты. При этом гкд проходит как надо."
    //
    // This method used to open with that gate as an EARLY RETURN over the entire body, so an OFF-GCD
    // spell never reached legs (2) or (3) below and got no cooldown of any kind. Every Man for Himself
    // is exactly that spell -- measured on the served `spell.dbc`, it reads
    // `startRecoveryCategory = 0`, `startRecoveryTime = 0`, so the gate fired and its real 120000 ms
    // was never applied. The owner's own two observations fall straight out of the same line: the GCD
    // "proceeds as it should" because an ON-GCD spell passes the gate and then reaches everything, and
    // the per-spell cooldown is missing precisely for the spells that do not.
    //
    // Measured, so the scale of it is a number rather than a guess -- every one of these was silently
    // cooldown-less: Every Man for Himself 59752 (category 1182, 120000 category), Blood Fury 20572
    // (120000 own), Berserking 26297 (180000 own), Vanish 1856 (category 39, 180000 category),
    // Stoneform 20594 and Will of the Forsaken 7744 (120000 own; both carry GCD category 133 but
    // `startRecoveryTime` 0, so they tripped the second half of the same gate).
    if (cast.startRecoveryCategory !== 0 && cast.startRecoveryTimeMs > 0) {
      for (const known of this.known) {
        const row = spellData.spell(known);
        if (row === null || row.startRecoveryCategory !== cast.startRecoveryCategory) {
          continue;
        }
        // `fromGcd` -- this is the entry a cancelled cast gives back. See `clearGlobalCooldown`.
        if (this.setCooldown(known, cast.startRecoveryTimeMs, at, true)) {
          changed = true;
        }
      }
    }

    // ── (2) THE SPELL'S OWN COOLDOWN, from the DBC: the server does not send a packet for a cooldown
    // the client can derive from its own tables. NOT `fromGcd`: a real cooldown survives a cancel.
    if (cast.recoveryTimeMs > 0 && this.setCooldown(spellId, cast.recoveryTimeMs, at, false)) {
      changed = true;
    }

    // ── (3) THE CATEGORY COOLDOWN -- a genuinely SEPARATE mechanism, and implemented rather than
    // folded into (2). A `Category` groups a family that shares one cooldown: the racial trinket
    // family, potions, the Vanish/Preparation group. It is the leg that matters most for the owner's
    // report, because Every Man for Himself carries its whole 2 minutes HERE and nothing in
    // `recoveryTime` at all -- so a fix that only reached (2) would have looked right on Blood Fury
    // and still shown nothing on the spell he actually pressed.
    //
    // NAMED LIMIT: the family is resolved over `this.known`, i.e. spells the character knows. A shared
    // cooldown that also covers ITEMS (a potion category shared with a trinket) is not applied to the
    // item, because this client has no item-cooldown surface at all -- `GetItemCooldown` is absent.
    // So the racial's own button dims and a category-mate item's would not.
    if (cast.categoryRecoveryTimeMs > 0 && cast.category !== 0) {
      for (const known of this.known) {
        const row = spellData.spell(known);
        if (row === null || row.category !== cast.category) {
          continue;
        }
        if (this.setCooldown(known, cast.categoryRecoveryTimeMs, at, false)) {
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
   * `Spell.dbc` is read here rather than waited for on the wire.
   *
   * **AND IT READS BOTH COOLDOWN COLUMNS, not just `RecoveryTime`.** It used to take
   * `recoveryTimeMs` alone, which is 0 for every spell whose cooldown lives in its CATEGORY -- so an
   * explicit server-sent cooldown event for Every Man for Himself (0 own, 120000 category) applied
   * nothing at all. The same blind spot as the early return in `applyCastCooldowns`, in a second
   * place, and it would have kept the owner's symptom alive on the packet path after the DBC path was
   * fixed. The LONGER of the two is taken, and the category leg is applied across the family exactly
   * as `applyCastCooldowns` leg (3) does.
   */
  private handleCooldownEvent(gp: GamePacket): void {
    gp.index = gp.headerSize;
    const bodySize = gp.length - gp.headerSize;
    const spellId = gp.readUnsignedInt();
    const guid = gp.readGUID();
    const row = spellData.spell(spellId);
    const own = row?.recoveryTimeMs ?? 0;
    const category = row?.categoryRecoveryTimeMs ?? 0;
    const ms = Math.max(own, category);
    spellWire.record({
      at: Date.now(),
      kind: 'COOLDOWN_EVENT',
      spellId,
      caster: String(guid),
      detail: {
        recoveryTimeMs: own, categoryRecoveryTimeMs: category, appliedMs: ms, name: row?.name ?? null,
      },
      bodySize,
      consumed: gp.index - gp.headerSize,
    });
    if (ms <= 0) {
      return;
    }
    const at = gameTime();
    let changed = this.setCooldown(spellId, ms, at, false);
    // The category family, when this spell has one -- the same separate mechanism leg (3) applies.
    if (category > 0 && row !== null && row.category !== 0) {
      for (const known of this.known) {
        const other = spellData.spell(known);
        if (other === null || other.category !== row.category) {
          continue;
        }
        if (this.setCooldown(known, category, at, false)) {
          changed = true;
        }
      }
    }
    if (changed) {
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

    /**
     * **THE LOGIN COOLDOWN BLOCK -- now decoded and APPLIED, and its stride widened from 14 to 16.**
     *
     * It used to be skipped (`gp.read(14)` per entry, "nothing consumes them yet"), so a character
     * who relogged with a cooldown running showed none: the server states it exactly once, here, and
     * nothing read it. That is the other half of the owner's cooldown report -- the live packets cover
     * a cooldown that STARTS while you are online, and only this covers one already running.
     *
     * **THE 14 WAS THE 1.12 WIDTH AND IT IS THE WIDTH TRAP, caught by reading rather than by a
     * failure.** 1.12's entry is `u16 spellId, u16 itemId, u16 category, u32 cooldown,
     * u32 categoryCooldown` = 14; 3.3.5a widens the id to `u32`, giving **16**. That is the SAME
     * widening this file's own header already records for the spell entries in this very packet
     * ("3.3.5a widens the id to `u32`, giving 6-byte entries") -- applied to one block of the packet
     * and not the other. A `u16` id in one block and a `u32` id in the next, in one server write, is
     * not a shape any implementation has.
     *
     * **AND THE ARITHMETIC THAT PINNED THIS PACKET CANNOT DISCRIMINATE IT**, which is exactly why it
     * survived: the header's proof is `1 + 2 + 6n + 2 + 14m = 329` solved with **m = 0**, so the
     * stride was multiplied by zero and never tested. A fresh character has no cooldowns, so every
     * capture this client has seen exercises this block not at all.
     *
     * So: **self-consistent, NOT residual-verified.** No body with `m > 0` has been through it. The
     * diagnostic below is written to NAME the error rather than only report one, per `CLAUDE.md`:
     * this block is the packet's TAIL, so a wrong stride leaves a remainder, and dividing that
     * remainder by the wire's own count localises it --
     *
     *   - `perEntry` a whole number: the error is INSIDE the entry and that is its size in bytes.
     *     A `u16` id read where a `u32` sits is exactly `+2`, which is the mistake this fixes, so a
     *     future reading of 14 would report `perEntry 2` and name itself.
     *   - `perEntry` null with a nonzero remainder: the stride is right and the HEADER moved.
     *   - a stride too LARGE would normally show as a throw, and `CLAUDE.md` asks for that third
     *     arm -- but it is UNREACHABLE here and that is by construction rather than by luck: the
     *     loop is bounded by `gp.available >= COOLDOWN_ENTRY` as well as by the wire count, so it
     *     stops short rather than over-reading. An over-large stride therefore reports as
     *     `cooldownsRead` BELOW `cooldownCount` with a nonzero residual, which is the same
     *     information without the exception. Said plainly rather than leaving a reader to wonder
     *     where the throw arm went.
     */
    let cooldownCount = 0;
    const COOLDOWN_ENTRY = 16;
    let cooldownsRead = 0;
    if (gp.available >= 2) {
      cooldownCount = gp.readUnsignedShort();
      const at = gameTime();
      for (let i = 0; i < cooldownCount && gp.available >= COOLDOWN_ENTRY; i += 1) {
        const spellId = gp.readUnsignedInt() >>> 0;
        gp.readUnsignedShort(); // itemId -- the item that granted it; no item-cooldown surface here
        const category = gp.readUnsignedShort();
        const ownMs = gp.readUnsignedInt() >>> 0;
        const categoryMs = gp.readUnsignedInt() >>> 0;
        cooldownsRead += 1;
        // REMAINING milliseconds, not total: the server is describing a cooldown already under way,
        // so this is exactly what `setCooldown` wants and no elapsed time is subtracted.
        const ms = Math.max(ownMs, categoryMs);
        if (spellId !== 0 && ms > 0) {
          // NOT `fromGcd`: a cooldown that survived a relog is a real one, and a later cancelled cast
          // must not refund it.
          this.setCooldown(spellId, ms, at, false);
        }
        // NAMED LIMIT, and it is a limit of WHERE this runs rather than of the decode: the category
        // cooldown is applied to the spell the packet NAMES and is not expanded across its family.
        // It cannot be expanded here -- `Spell.dbc` is deliberately not loaded at login (the note
        // below measures why: fetching 49 MB in the login burst starved the FrameXML manifest for
        // over 240 s), so there is no table to resolve a category against. In practice the server
        // sends one entry per spell that has a cooldown running, so a family whose members are all on
        // cooldown is all named; a member the server omits keeps an undimmed button until the next
        // live packet. `category` is read rather than skipped so the entry closes and so the value is
        // in the wire record.
        void category;
      }
    }
    const cooldownResidual = bodySize - (gp.index - gp.headerSize);
    const cooldownPerEntry = cooldownsRead > 0 && cooldownResidual !== 0
      && cooldownResidual % cooldownsRead === 0
      ? cooldownResidual / cooldownsRead
      : null;

    this.known = new Set(found);
    spellWire.record({
      at: Date.now(),
      kind: 'INITIAL_SPELLS',
      spellId: 0,
      caster: null,
      detail: {
        spellCount,
        decoded: found.length,
        cooldownCount,
        cooldownsRead,
        cooldownEntryBytes: COOLDOWN_ENTRY,
        // See the cooldown block above: these two are the diagnostic that NAMES a wrong stride.
        cooldownResidual,
        cooldownPerEntry,
        first: found[0] ?? null,
      },
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
      if (this.applyCastCooldowns(decoded.spellId)) {
        this.announceCooldowns();
      }
      // The in-flight guard was armed at SEND with a generous provisional window; START is the first
      // moment the real cast length is known, so tighten to it. `castTimeMs` is the server's own value
      // with haste and auras already folded in. Only for our own cast: a peer's START is not our guard.
      this.pendingCast.refine(decoded.castTimeMs, Date.now());
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
    // `interrupt` true, and the fourth argument -- `holdClamped` -- is what makes this hold for a pose
    // that does NOT loop.
    //
    // A LOOPING pose (`ReadySpellOmni`/`ReadySpellDirected`) holds by itself: `Unit#externalSeq`'s latch
    // never releases a loop. **A CLAMP does not**, and the owner found the case -- opening a bucket casts
    // `Opening`, whose precast pose is `Loot` (50), an authored clamp: "проигрывается анимация лута, долю
    // секунды, потом он встает". The clip ended, its window elapsed, and the latch handed the body back.
    // The reference holds the same clip with `RepeatAnimation::Never` and "a deliberate freeze -- no
    // window either" (`creature_anim/driver/mode.rs:523-527`); `holdClamped` is that, and it changes
    // nothing for a looping pose or for any combat one-shot.
    //
    // The ways out are unchanged: the release armed at GO replaces the latch, and
    // `releaseAnimationLatch` below is the exit when the cast never gets there.
    const caster = this.game.world.entities.get(decoded.caster);
    if (caster) {
      const pose = precastAnimationFor(caster, decoded.spellId);
      if (pose !== null) {
        caster.setAnimation(pose, true, -1, true);
        // RECORDED so a later failure can tell this pose from any other latch -- see `castPose`.
        this.castPose.set(decoded.caster, { spellId: decoded.spellId, animId: pose });
      }
      // THE PRECAST KIT'S EMITTER MODELS, beside the pose because they are the same stage of the same
      // edge: `precastKitID`'s pose is one column of the kit and its effect slots are eleven more.
      // PERSISTENT -- a held pose and a held glow have the same lifetime, and the kit lives until its
      // spell-id-keyed reap at GO (`spell_fx/mod.rs:15-19`). `world/spell-kit-effects.ts` owns the rest.
      const precastKit = spellData.precastKit(decoded.spellId);
      if (precastKit !== null) {
        this.game.world.playSpellKit(caster, decoded.spellId, precastKit, true);
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
    // THE TAIL, decoded before anything reads it. `readCastHead` has already validated the cursor.
    const targets = this.readSpellGoTargets(gp);
    // RECORDED for every GO, because the missile lane depends entirely on this and the decode has
    // never been checked against captured traffic. One live cast now says what the wire carried:
    // a plausible mask with a hit count is a working decode, an implausible one names the defect.
    spellWire.record({
      at: Date.now(),
      kind: 'SPELL_GO',
      spellId: decoded.spellId,
      caster: decoded.caster,
      detail: {
        tailPlausible: targets.plausible ? 1 : 0,
        targetMask: targets.targetMask,
        hits: targets.hits.length,
        misses: targets.misses.length,
        hasDest: targets.dest === null ? 0 : 1,
      },
      bodySize: gp.length - gp.headerSize,
      consumed: gp.index - gp.headerSize,
    });

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

      // THE KIT HAND-OVER, the same shape as the pose's above: the precast kit is reaped and the cast
      // kit armed. Reap FIRST so a persistent precast glow dies before the release flash appears --
      // the reference's own emission order (`spell_fx/mod.rs:657-660`, "a GO's reap-then-begin lands
      // in emission order, so the precast dies before the release flash").
      //
      // The cast kit is NOT persistent: it self-terminates after one pass of its model's sequence 0.
      //
      // The IMPACT kit is absent on purpose and is not a silent gap -- it plays on the TARGETS, and
      // this packet's hit list is exactly the tail this method says it does not decode. Named in
      // `world/spell-kit-effects.ts`, which cannot reach it either.
      this.game.world.spellKitEffects.reap(decoded.caster, decoded.spellId);
      const castKit = spellData.castKit(decoded.spellId);
      if (castKit !== null) {
        this.game.world.playSpellKit(unit, decoded.spellId, castKit, false);
      }

      // THE PROJECTILE -- the owner's "основная вещь", and the one thing this subsystem was missing.
      // Gated on `Spell.dbc` Speed inside `SpellMissiles#launch`, which is the reference's whole spawn
      // test. The IMPACT kit now rides its arrival rather than being unreachable: both halves came from
      // decoding the target tail above, which is why one decode closed two gaps.
      //
      // Guarded on the tail being trustworthy. A `plausible` false means the stride check failed, and
      // flying projectiles at guids read out of a mis-strided body would put fireballs at random units.
      if (targets.plausible) {
        this.game.world.launchSpellMissiles(
          unit,
          decoded.spellId,
          targets.hits,
          targets.misses.map((m) => m.guid),
          targets.dest,
        );
        // A SPELL WITH NO PROJECTILE STILL HAS AN IMPACT STAGE, and it had no way to reach it.
        //
        // `playImpactKit` is wired into exactly one caller: the missile lane's arrival callback
        // (`world/index.ts:1320`). `SpellMissiles#launch` refuses a spell whose `Spell.dbc` Speed is
        // 0 -- correctly, there is no projectile to fly -- and returns at its `speedless` guard. So
        // for every instant self-buff the impact kit was unreachable, silently.
        //
        // MEASURED on the owner's report ("должен быть такой щит над головой, и потом пропасть, но
        // такого нет"): Demon Skin 687 -> `SpellVisual` 130 -> **impact kit 227, head slot, tag 0x14
        // = `DemonArmor_Impact_Head.mdx`** -- the shield over the head, and the ONLY slot in the whole
        // chain that carries it. Its precast kit 217 and cast kit 218 carry hand art only, its state
        // kit is 0, and Speed is 0.00. Every rank shares visual 130, and `Demon Armor` and `Fel Armor`
        // do too. So the entire visual he is missing lives in the one stage nothing could play.
        //
        // Inside the `plausible` gate deliberately: these are guids off the same decoded tail the
        // missile lane refuses to trust when its stride check fails, and playing a kit on a
        // mis-strided guid would put a shield on a random unit.
        if (!(spellData.spellSpeed(decoded.spellId) > 0)) {
          for (const guid of targets.hits) {
            this.game.world.playImpactKit(guid, decoded.spellId);
          }
        }
      } else {
        // NAMED, not silent. This gate is the missile lane's alone -- the kit lane never reads the
        // tail -- and it is the first candidate for "снаряда не видно" while the hand kit IS visible.
        // The decode is labelled self-consistent rather than residual-verified, so it failing its own
        // stride check is a real possibility and must show up as a number rather than as an absence.
        this.game.world.spellMissiles.noteImplausibleTail();
      }
    }

    // THE GLOBAL COOLDOWN for an INSTANT spell, which is the only kind that reaches here without having
    // been stamped already. An instant sends no `SMSG_SPELL_START` at all -- so `castStarted` is empty for
    // it and this is its one chance -- while a timed cast was stamped at START and is skipped here, or the
    // later stamp would win and double the GCD. `world.player` is the authority on which guid is ours; a
    // peer's confirmed cast must not put a cooldown on our bar.
    if (decoded.caster === this.game.world.player?.guid) {
      if (this.castStarted.delete(decoded.spellId)) {
        // Timed cast: already stamped at START. Nothing to do.
      } else if (this.applyCastCooldowns(decoded.spellId)) {
        this.announceCooldowns();
      }
      // The cast RESOLVED -- open the in-flight guard so the next press goes out. Spell-id-keyed, which
      // is what stops a triggered proc's GO (a different spell, arriving mid-cast) opening it early.
      this.pendingCast.clearIf(decoded.spellId);
    }

    this.emit('spellGo', { ...decoded, targets });
  }


  /**
   * `SMSG_SPELL_GO`'s TARGET TAIL -- the hit list, the miss list and the ground point.
   *
   * This is the tail this method said for four rounds it deliberately did not decode. It is decoded
   * now because ONE decode closes TWO gaps: the missile needs a destination and the impact kit needs
   * to know whose body to play on, and both are in this block.
   *
   * ## The layout, and the two width deltas that are already handled upstream
   *
   * **The layout is the SERVER IMPLEMENTATIONS' shape, not measured off a capture** -- the same
   * standing this file's `CMSG_CANCEL_CAST` and `CMSG_SET_ACTION_BUTTON` notes take. It is
   * TrinityCore's `Spell::WriteSpellGoTargets` followed by `SpellCastTargets::Write`, and it is
   * labelled rather than asserted because nothing available from here can observe the difference.
   * What IS measured is the cursor it starts from: `readCastHead`'s own live-wire measurement (the
   * `1500`/`2` reading recorded on it) pins where this block begins.
   *
   * Read from immediately after `readCastHead`, which has consumed the two guids, `castCount`,
   * `spellId`, `castFlags` and the one `u32` timestamp:
   *
   *     u8  hitCount
   *     hitCount  x  u64 guid            -- FULL eight bytes, NOT packed
   *     u8  missCount
   *     missCount x (u64 guid, u8 missCondition [, u8 reflectResult when condition == 11 REFLECT])
   *     u32 targetMask                   -- `SpellCastTargets`
   *     ... mask-dependent blocks, then castFlags-dependent blocks
   *
   * The two 1.12 -> 3.3.5a width deltas in this packet are `castFlags` (u16 -> u32) and the `castCount`
   * byte that did not exist in 1.12, and BOTH are consumed by `readCastHead`, which self-checks its
   * `spellId` precisely so a 1.12-shaped read cannot reach here. So this block inherits an already
   * validated cursor rather than re-deriving the offset -- which is the shape that made the quest-area
   * defect land its strings 8 bytes early.
   *
   * The guids here are NOT packed, and that is the trap worth naming: every other guid in this file is
   * packed, so reusing `readPackedGUID` would read one byte where eight sit and walk the rest of the
   * body off by seven per target.
   *
   * ## SELF-CONSISTENT, NOT RESIDUAL-VERIFIED, and the difference is stated on purpose
   *
   * `CLAUDE.md` is explicit that only a residual against captured traffic settles a layout, and no
   * capture is available from here -- so this says "self-consistent" as instructed. What it DOES have
   * is an oracle that costs nothing and is not self-built: after the two lists, the next word must be
   * a `SpellCastTargets` mask, i.e. a small bitmask drawn from known flags. A wrong stride in either
   * list lands a guid word or a garbage count there instead, and `MASK_PLAUSIBLE` catches it. That is
   * the same trick `readCastHead` uses on `spellId`, and it is reported through `spellWire` rather
   * than thrown, so a bad read shows up as a named record instead of a missing missile.
   *
   * The remainder is NOT asserted to be zero, deliberately: the mask-dependent and castFlags-dependent
   * blocks that follow are not consumed here (each is its own width risk and nothing needs them), so a
   * non-zero remainder is expected and is recorded as `left` rather than treated as an error.
   */
  private readSpellGoTargets(gp: GamePacket): SpellGoTargets {
    // `TARGET_FLAG_*`, the bits this build's `SpellCastTargets::Read` knows. Used only as the
    // plausibility oracle above and to decide whether a ground point follows.
    const TARGET_FLAG_UNIT = 0x0002;
    const TARGET_FLAG_ITEM = 0x0010;
    const TARGET_FLAG_SOURCE_LOCATION = 0x0020;
    const TARGET_FLAG_DEST_LOCATION = 0x0040;
    const TARGET_FLAG_STRING = 0x2000;
    const TARGET_FLAG_GAMEOBJECT = 0x0800;
    const TARGET_FLAG_CORPSE_ALLY = 0x8000;
    const MASK_KNOWN = 0xffff;
    /** `SPELL_MISS_REFLECT`, the one miss condition that carries a second byte. */
    const MISS_REFLECT = 11;

    const hits: string[] = [];
    const misses: Array<{ guid: string; condition: number }> = [];
    let targetMask = 0;
    let dest: { x: number; y: number; z: number } | null = null;
    let plausible = false;

    try {
      const hitCount = gp.readUnsignedByte();
      for (let i = 0; i < hitCount; i += 1) {
        hits.push(this.readFullGuid(gp));
      }
      const missCount = gp.readUnsignedByte();
      for (let i = 0; i < missCount; i += 1) {
        const guid = this.readFullGuid(gp);
        const condition = gp.readUnsignedByte();
        if (condition === MISS_REFLECT) {
          gp.readUnsignedByte();
        }
        misses.push({ guid, condition });
      }
      targetMask = gp.readUnsignedInt();
      // THE ORACLE. A real mask uses only the low bits this build defines; a stride error puts a guid
      // word or a count here, which overwhelmingly fails this.
      plausible = (targetMask & ~MASK_KNOWN) === 0;

      if (plausible) {
        // Only the blocks needed to find a GROUND point are walked, in `SpellCastTargets::Read` order.
        if ((targetMask & (TARGET_FLAG_UNIT | TARGET_FLAG_CORPSE_ALLY | TARGET_FLAG_GAMEOBJECT)) !== 0) {
          gp.readPackedGUID();
        }
        if ((targetMask & TARGET_FLAG_ITEM) !== 0) {
          gp.readPackedGUID();
        }
        if ((targetMask & TARGET_FLAG_SOURCE_LOCATION) !== 0) {
          gp.readPackedGUID();
          gp.readFloat();
          gp.readFloat();
          gp.readFloat();
        }
        if ((targetMask & TARGET_FLAG_DEST_LOCATION) !== 0) {
          gp.readPackedGUID();
          const x = gp.readFloat();
          const y = gp.readFloat();
          const z = gp.readFloat();
          dest = { x, y, z };
        }
        // `TARGET_FLAG_STRING`'s cstring is deliberately NOT consumed: nothing needs it and a
        // cstring read is its own width risk. It is the last block in `SpellCastTargets`, so skipping
        // it costs nothing here -- everything this method returns has already been read.
      }
    } catch (error) {
      // A short body is a real outcome (a truncated packet, or a stride wrong enough to over-read).
      // Recorded, never thrown: the caller degrades to "no targets" and the cast still animates.
      spellWire.record({
        at: Date.now(),
        kind: 'SPELL_GO',
        spellId: 0,
        caster: null,
        detail: { targetsError: String(error), hits: hits.length, misses: misses.length },
        bodySize: gp.length - gp.headerSize,
        consumed: gp.index - gp.headerSize,
      });
      return { hits, misses, targetMask, dest, plausible: false };
    }

    return { hits, misses, targetMask, dest, plausible };
  }

  /** Eight little-endian bytes -> the normalised guid string. See `guid-hex.ts` for why not a Number. */
  private readFullGuid(gp: GamePacket): string {
    const bytes = new Uint8Array(GUID_BYTES);
    for (let i = 0; i < GUID_BYTES; ++i) {
      bytes[i] = gp.readUnsignedByte();
    }
    return guidHex(bytes);
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
    // AND THE GCD GOES BACK. This is the reference's own trigger, named exactly: the GCD is armed at
    // send and "a later `SMSG_CAST_RESULT` failure clears it again (`0x6e1630`)"
    // (`ui_action/cast_send.rs:643-647`) -- `SMSG_CAST_FAILED` is 3.3.5a's name for that packet.
    // Ordinarily a no-op, because a refused cast usually got no START and so stamped no GCD; the case
    // it covers is a cast that STARTED and was then refused, which is also the only case the pose
    // release below covers.
    this.clearGlobalCooldown();
    // `SMSG_CAST_FAILED`'s body names no caster -- the server only refuses OUR casts -- so the pose to
    // release is the player's. Ordinarily there is none to release: a refused cast gets no START either,
    // so no pose was ever armed. The case this covers is a cast that STARTED and was then refused.
    const self = this.game.world.player?.guid;
    if (self !== undefined) {
      this.releaseCastPose(self, spellId);
    }
    // Open the guard. `clearIf` is spell-id-keyed, so a refusal naming a spell that is NOT the one in
    // flight leaves the guard alone -- which is the correct answer now that the send path refuses a
    // duplicate locally: any `SMSG_CAST_FAILED` that still names a different spell came from a route
    // that does not go through the guard (an item use, a server-initiated refusal), and must not open it.
    this.pendingCast.clearIf(spellId);
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
/**
   * `CMSG_CAST_SPELL` at a GAMEOBJECT -- the OPEN_LOCK route, which is how a locked chest is opened.
   *
   * **A locked object is not opened with `CMSG_GAMEOBJ_USE` at all**, and that is the reference's law
   * rather than an inference: "a locked object (chest / mining vein / herb node / locked door) casts an
   * `OPEN_LOCK` spell at it, an unlocked one sends `CMSG_GAMEOBJ_USE`"
   * (`benilla-app/src/go_templates.rs:3-5`). The owner's bucket is a chest with a lock, which is why his
   * `CMSG_GAMEOBJ_USE` went out correctly and the server answered nothing at all -- an inbound watch
   * over the three seconds after the click caught only unrelated traffic.
   *
   * THE TARGET MASK IS `0x4800`, and it is the reference's own assertion for this exact spell:
   * `assert_eq!(opening & (TF_GAMEOBJECT | TF_LOCKED), opening)` with `TF_GAMEOBJECT = 0x0800` and
   * `TF_LOCKED = 0x4000` (`ui_action/cast_target.rs:86,90,577-578`). Both flags read ONE packed guid on
   * the server side and they are read in the same branch, so the pair carries a single packed guid and
   * not two -- which is what makes 0x4800 safe rather than a double write.
   *
   * Everything else is `castSpell`'s body above, unchanged and for its reasons: `castCount` 0,
   * `castFlags` 0, and the 1.12 delta it records (the reference's own `CMSG_CAST_SPELL` has neither, and
   * sending its form here shifts the mask by two bytes).
   */
  castAtObject(spellId: number, objectGuid: string): void {
    const TARGET_FLAG_GAMEOBJECT = 0x0800;
    const TARGET_FLAG_LOCKED = 0x4000;

    const body = 1 + 4 + 1 + 4 + packedGuidLength(objectGuid);
    const app = new GamePacket(GameOpcode.CMSG_CAST_SPELL, 6 + body);
    app.writeUnsignedByte(0);
    app.writeUnsignedInt(spellId);
    app.writeUnsignedByte(0);
    app.writeUnsignedInt(TARGET_FLAG_GAMEOBJECT | TARGET_FLAG_LOCKED);
    app.writePackedGUID(objectGuid);
    this.game.send(app);

    spellWire.record({
      at: Date.now(),
      kind: 'CAST_SENT',
      spellId,
      caster: null,
      detail: {
        target: objectGuid,
        name: spellData.spell(spellId)?.name ?? null,
        bodyBytes: body,
        objectTarget: 1,
      },
      bodySize: body,
      consumed: body,
    });
  }

  /**
   * THE IN-FLIGHT REFUSAL, and the reason `castSpell` now has a return value.
   *
   * `'sent'` the packet went out. `'busy-same'` the same spell is already casting -- the real client
   * bails SILENTLY here (`6e4d43`), so the caller must show nothing. `'busy-other'` a different spell is
   * casting -- the real client shows its own red line, reason 0x61 "Another action is in progress"
   * (`6e4d97`), and still sends nothing.
   *
   * Both arms are `samples/benilla/crates/benilla-app/src/ui_action/cast_send.rs:283-297`. Neither sends
   * a packet, which is the entire fix: see `game/classes/pending-cast.ts`.
   */
  /**
   * **THE TARGET IS NOW RESOLVED, NOT COPIED** -- see `game/classes/cast-target.ts`.
   *
   * This used to ship the current selection whenever there was one, for every spell. That is the
   * owner's "не могу кастовать дружественные заклинания, типа хил, пока в таргете противник": with a
   * wolf selected, a heal went out aimed at the wolf and a self-buff went out aimed at the wolf, and
   * the server refused both. The real client resolves the target locally first, and the two arms that
   * matter are a `Targets` word of ZERO (ship `TARGET_FLAG_SELF` and no guid) and the autoSelfCast
   * fallback to the player. `cast-target.ts` carries the mechanism, its citations and the DBC
   * measurement that establishes which column decides.
   *
   * **NO WIRE SHAPE CHANGES HERE, and that is what keeps the width trap out of this fix.** Both
   * bodies this can now send are bodies this method already sent: `TARGET_FLAG_UNIT` + a packed guid
   * (what a targeted press sent), and `TARGET_FLAG_SELF` with nothing following (what a press with no
   * selection sent). The resolution only chooses BETWEEN them, so there is no new length, no new
   * field and nothing to widen -- and the exact sizing below is unchanged.
   *
   * `autoSelfCast` is passed in rather than read here because the CVar store lives on the Lua side;
   * `ui/cast-refusal.ts` reads it and it is the ONE door, so there is one reader.
   */
  castSpell(
    spellId: number,
    target: string | null,
    autoSelfCast: boolean,
  ): 'sent' | 'busy-same' | 'busy-other' | 'no-target' | 'invalid-target' {
    const TARGET_FLAG_SELF = 0x0000;
    const TARGET_FLAG_UNIT = 0x0002;

    // THE GUARD, ahead of everything. A duplicate press must not reach the wire: the server would refuse
    // it with `SPELL_FAILED_SPELL_IN_PROGRESS` and that refusal used to close the RUNNING cast's bar.
    const now = Date.now();
    const inFlight = this.pendingCast.current(now);
    if (inFlight !== null) {
      return inFlight === spellId ? 'busy-same' : 'busy-other';
    }

    const world = this.game.world;
    const selfGuid = world?.player?.guid ?? null;
    const selection = target !== null && target !== '0x0' ? target : null;
    const wire = resolveCastTarget(
      spellData.spell(spellId),
      selection,
      selfGuid,
      autoSelfCast,
      {
        target: selection === null ? null : world?.entities?.get(selection) ?? null,
        self: selfGuid === null ? null : world?.entities?.get(selfGuid) ?? world?.player ?? null,
      },
    );
    if (wire.kind === 'refused') {
      // REFUSED LOCALLY AND NOT SENT, which is the reference's own behaviour for a word it cannot
      // bind. Recorded so a probe can see which word was refused rather than only that a press did
      // nothing -- the targeting-cursor families (Flamestrike, Blizzard, Mining, Opening) all land
      // here and `cast-target.ts` names that gap.
      spellWire.record({
        at: Date.now(),
        kind: 'CAST_REFUSED',
        spellId,
        caster: null,
        detail: {
          word: wire.word,
          error: wire.error,
          selection,
          name: spellData.spell(spellId)?.name ?? null,
        },
        bodySize: 0,
        consumed: 0,
      });
      return wire.error === ERR_NO_TARGET ? 'no-target' : 'invalid-target';
    }

    // The body is sized exactly, because `GameHandler#send` derives the packet's declared LENGTH from
    // the buffer size -- an over-allocated buffer sends a wrong length field, which `handler.js` records
    // as a real defect it has already been bitten by.
    const targeted = wire.kind === 'unit';
    const guidBytesLength = targeted ? packedGuidLength(wire.guid) : 0;
    const body = 1 + 4 + 1 + 4 + guidBytesLength;

    const app = new GamePacket(GameOpcode.CMSG_CAST_SPELL, 6 + body);
    app.writeUnsignedByte(0);
    app.writeUnsignedInt(spellId);
    app.writeUnsignedByte(0);
    app.writeUnsignedInt(targeted ? TARGET_FLAG_UNIT : TARGET_FLAG_SELF);
    if (targeted) {
      app.writePackedGUID(wire.guid);
    }
    this.game.send(app);
    // OPTIMISTIC: armed on the send, not on `SMSG_SPELL_START`, because the mashing lands during that
    // round trip. Tightened to the server's real cast time when START names it.
    this.pendingCast.arm(spellId, now);

    spellWire.record({
      at: Date.now(),
      kind: 'CAST_SENT',
      spellId,
      caster: null,
      detail: {
        // The RESOLVED target, and the selection it came from -- so a probe can see the fallback
        // happen (`selection` a wolf, `target` ourselves) rather than only its result.
        target: targeted ? wire.guid : null,
        selection,
        selfCast: targeted && wire.guid === selfGuid ? 1 : 0,
        name: spellData.spell(spellId)?.name ?? null,
        bodyBytes: body,
      },
      bodySize: body,
      consumed: body,
    });
    return 'sent';
  }

  /**
   * `CMSG_CANCEL_CAST` (0x12F): stop the cast in flight. Escape's own leg -- see
   * `game/ui/target-bridge.ts#SpellStopCasting` for the precedence it sits in.
   *
   * 3.3.5a body: `u8 castCount`, `u32 spellId`. **The layout is the SERVER IMPLEMENTATIONS' shape, not
   * measured off a capture** -- the same standing this file's `CMSG_SET_ACTION_BUTTON` note takes:
   * TrinityCore's `HandleCancelCastOpcode` reads and discards a leading counter byte and then the
   * spell id. It is labelled rather than asserted because nothing here can observe the difference: a
   * cancel the server rejects is silent.
   *
   * `castCount` is the same value `castSpell` sent (0 for every cast this client makes), echoed so a
   * server that does match them matches this one.
   */
  cancelCast(spellId: number, castCount: number): void {
    const body = 1 + 4;
    const app = new GamePacket(GameOpcode.CMSG_CANCEL_CAST, GamePacket.HEADER_SIZE_OUTGOING + body);
    app.writeUnsignedByte(castCount & 0xff);
    app.writeUnsignedInt(spellId);
    this.game.send(app);

    // The cast is over as far as we are concerned, so the guard must open NOW rather than waiting for
    // the server's echo -- otherwise Escape (or a movement cancel) would leave the guard holding and the
    // next press would be refused as a duplicate of a cast that is already cancelled.
    this.pendingCast.clearIf(spellId);

    spellWire.record({
      at: Date.now(),
      kind: 'CANCEL_SENT',
      spellId,
      caster: null,
      detail: { castCount },
      bodySize: body,
      consumed: body,
    });
  }

  /**
   * `CMSG_CANCEL_CHANNELLING` (0x13B): stop a CHANNEL. A different opcode from `CMSG_CANCEL_CAST` and
   * not interchangeable with it.
   *
   * 3.3.5a body: `u32 spellId`. TrinityCore's `HandleCancelChanneling` reads one `uint32`; the same
   * server-implementation standing `cancelCast` above declares. **The longer-body rule does not help
   * here and is not applied**: there is no second word this could be, and a cancel the server rejects is
   * silent either way.
   *
   * **MOVEMENT ONLY -- Escape can never reach a channel**, and that asymmetry is the reference's,
   * verified rather than assumed: `Script::SpellStopCasting 0x6e6e80`'s callee closure never calls the
   * channel canceller `0x6e9b70`, and its in-flight word is already 0 mid-channel because the launch
   * result cleared it (`ui_cast.rs:366-374`). That is the vanilla "/stopcasting cannot stop a channel"
   * quirk, and it is kept.
   *
   * Nothing local is torn down, which is also the reference's: `0x6e9b70` fires no event and clears no
   * state -- the channel bar closes on the server's `SMSG_CHANNEL_UPDATE(0)`.
   */
  cancelChannelling(spellId: number): void {
    const body = 4;
    const app = new GamePacket(GameOpcode.CMSG_CANCEL_CHANNELLING, GamePacket.HEADER_SIZE_OUTGOING + body);
    app.writeUnsignedInt(spellId);
    this.game.send(app);

    spellWire.record({
      at: Date.now(),
      kind: 'CANCEL_SENT',
      spellId,
      caster: null,
      detail: { channelling: 1 },
      bodySize: body,
      consumed: body,
    });
  }

  /**
   * The spell id of our outstanding cast, or null -- the guard's read side.
   *
   * This is what the movement cancel asks (`game/ui/world-ui.ts`): it needs to know WHICH spell is in
   * flight so it can consult that spell's own `InterruptFlags`, and it needs the answer during the
   * send -> `SMSG_SPELL_START` window as well as after it, which the cast-bar snapshot cannot give.
   */
  currentCast(): number | null {
    return this.pendingCast.current(Date.now());
  }

  /**
   * Open the in-flight guard without sending anything -- the OFFLINE world's cancel leg.
   *
   * `/game?offline=1` has no wire, so `cancelCast` (which opens the guard as a side effect of sending)
   * is not called there. Without this the guard would stay armed until its 5 s provisional deadline and
   * casting would appear to lock up after the first cancelled cast. Spell-id-keyed like every other
   * clear, so it cannot open a guard belonging to a later cast.
   */
  releaseCastGuard(spellId: number): void {
    this.pendingCast.clearIf(spellId);
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

  /**
   * EMPTY a slot: an ability dragged off the bar and dropped on the world.
   *
   * `setActionButton(action, null)` is already the remove form -- `packedData == 0`, which the server
   * treats as "drop this button" -- so this adds only the `actionsChanged` the UI redraws on. Without the
   * emit the server forgets the action and the bar keeps drawing it until the next relog, which is
   * measurably what happened when a probe called `setActionButton` directly: `HasAction(7)` still read
   * true afterwards.
   */
  clearActionButton(action: number): void {
    if (this.spellInSlot(action) === null) {
      return;
    }
    this.setActionButton(action, null);
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
