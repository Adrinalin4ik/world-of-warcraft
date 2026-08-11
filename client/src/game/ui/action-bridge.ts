/**
 * THE SEAM between the server's action bar and the client's own action buttons.
 *
 * `lua/api/actions.ts` holds 144 snapshots and says at the top that it contains no world, no network and
 * no DBCs -- the host writes it and the Lua reads it. This is that host, and it is the exact counterpart
 * of `unit-bridge.ts`, including its two rules:
 *
 *  1. **Push, then fire.** Every FrameXML handler re-reads through `HasAction`/`GetActionTexture` the
 *     moment it runs, so firing first hands the old snapshot to the handler for the new state.
 *  2. **Fire only for what changed.** The in-world UI re-renders its offscreen target only when a
 *     fingerprint of the draw list changes (`world-ui.ts#drawListSignature`), and that is what took
 *     `ui.framexml` from ~10 ms to ~1 ms. An event fired here re-runs `ActionButton_Update`, which
 *     rewrites a texture, which changes the fingerprint, which costs a full pass. So this bridge is
 *     entirely event-driven -- no polling, no per-frame work -- and it diffs before it announces.
 *
 * ## Why art registration is not the tree walk
 *
 * `registerTreeArt` (`framexml/manifest.ts`) walks the finished tree ONCE, after the load, registering
 * every `widget.sprite` it finds and fetching them. An icon path set AFTER that -- and every action icon
 * is, because `ActionButton_Update` calls `icon:SetTexture(...)` from an event handler -- would name a
 * sprite key that was never registered and never fetched, so `art.texture()` would return null for ever
 * and the icon would silently not draw. This bridge therefore registers each icon path and calls
 * `art.load()` itself after a batch of pushes. `GlueArt#load` is idempotent (it skips a key already
 * loaded from the same path), so re-calling it costs a Map lookup per registered def and no refetch.
 *
 * That hazard is general, not specific to this feature: it is the same reason the portrait and any
 * later dynamically-textured frame will need the same call.
 */
import World from '../world';
import { GlueArt } from './art';
import {
  ACTION_SLOTS, ActionSnapshot, emptyAction, getAction, setAction, setActionUseHandler,
  setBonusBarOffset,
} from './framexml/lua/api/actions';
import { SPELL_AUTO_ATTACK, SpellHandler } from '../../network/game/object/spells';
import { fireEvent } from './framexml/lua/events';
import { getCast, setCast } from './framexml/lua/api/casting';
import { gameTime } from './framexml/lua/compat';
import { spellData } from '../pipeline/dbc/spell-data';
import { shapeshiftData } from '../pipeline/dbc/shapeshift-data';
import { LuaVM } from './framexml/lua/vm';
import type Unit from '../classes/unit';

/**
 * Subscribe a VM to the server's action bar. Returns the teardown.
 *
 * `world.session.offline` has no protocol at all, so the caller must not attach this on the offline
 * route -- `world-ui.ts` gates it the same way it gates the unit bridge.
 */
export function attachActionBridge(vm: LuaVM, world: World, art: GlueArt): () => void {
  const spells: SpellHandler = world.game.objectHandler.spellHandler;

  /** How many pushes and events this bridge has made, for the frame-cost measurement. */
  const stats = { pushes: 0, events: 0, artLoads: 0, form: 0, bonusBar: 0 };

  /**
   * WHAT A SPELL COSTS, and whether the player can pay it -- `IsUsableAction`'s two returns.
   *
   * `Spell.dbc` states a cost two different ways and BOTH have to be read:
   *
   *  - `manaCost` (column 42), an absolute amount. Rage and energy abilities use this. Rage is stored
   *    x10 in the DBC *and* x10 on the wire, so Heroic Strike's 150 compares directly against
   *    `UNIT_FIELD_POWER2` with no scaling -- that correspondence is what `spell-data.ts`'s header cites
   *    as independent corroboration of the column.
   *  - `manaCostPercentage` (column 204), a percentage of BASE mana. Most caster spells use this and
   *    leave `manaCost` at 0: measured on the served file, Fireball is 8%, Healing Wave 13%, Smite 9%,
   *    all with `manaCost` 0. The base is `UNIT_FIELD_BASE_MANA` off the wire and NOT `maxPower` --
   *    substituting max mana would overstate the cost by whatever the character's gear adds and grey the
   *    button early, which is the "visible lie" this project's rules warn about.
   *
   * The `powerType` must MATCH: a rage ability read against a shaman's mana would be trivially
   * affordable and a mana spell read against a warrior's rage never affordable. A cost stated in a power
   * the player does not have leaves the button bright (nothing is asserted) rather than dark.
   *
   * WHAT IS NOT CHECKED, stated rather than implied by the code's silence: form/stance gating, reagents,
   * required equipment, required target aura, and cooldown. `ActionButton_UpdateUsable` is only ever
   * asked "affordable?" here, so a form-gated ability is drawn bright. The cooldown is deliberate --
   * the real client's `isUsable` ignores cooldowns too, because the sweep already shows one.
   */
  const usability = (spellId: number): { usable: boolean; notEnoughPower: boolean } => {
    const row = spellData.spell(spellId);
    const player = world.player;
    if (row === null || player === undefined || player === null) {
      // No table or no player: nothing is asserted, so the button stays bright.
      return { usable: true, notEnoughPower: false };
    }
    const playerPowerType = player.fields.powerType ?? 0;
    if (row.powerType !== playerPowerType) {
      return { usable: true, notEnoughPower: false };
    }
    let cost = row.manaCost;
    if (cost === 0 && row.manaCostPercentage > 0) {
      const base = player.fields.baseMana ?? 0;
      if (base === 0) {
        // `UNIT_FIELD_BASE_MANA` has not arrived. Bright rather than a guess off `maxPower`.
        return { usable: true, notEnoughPower: false };
      }
      cost = Math.floor((base * row.manaCostPercentage) / 100);
    }
    if (cost <= 0) {
      return { usable: true, notEnoughPower: false };
    }
    const power = player.fields.power ?? 0;
    const affordable = power >= cost;
    // `notEnoughPower` is the SECOND return and only read when the first is false
    // (`actionbutton.lua:313-328`), so the pair is "affordable" and "the reason is power".
    return { usable: affordable, notEnoughPower: !affordable };
  };

  /**
   * `IsActionInRange`'s three-valued answer -- `null` / 0 / 1. See `ActionSnapshot#inRange`.
   *
   * `null` for every case where there is nothing to say: no target, a spell with no range in
   * `SpellRange.dbc` (melee and self-cast both read 0 there), or a table still loading. That is what
   * keeps the range dot off a melee button, which is the real client's behaviour.
   *
   * The distance is measured in the world's own units, which are YARDS -- the same units
   * `SpellRange.dbc` stores. It is a 3D distance including height, which is what the server checks.
   */
  const rangeOf = (spellId: number): number | null => {
    const yards = spellData.maxRange(spellId);
    if (yards === null) {
      return null;
    }
    const player = world.player;
    const targetGuid = world.game.objectHandler.combatHandler.selection;
    if (!player || targetGuid === null) {
      return null;
    }
    const target = world.entities.get(targetGuid);
    if (!target) {
      return null;
    }
    const dx = target.position.x - player.position.x;
    const dy = target.position.y - player.position.y;
    const dz = target.position.z - player.position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= yards ? 1 : 0;
  };

  /** Build the snapshot for one 1-based slot from the handler and the DBC tables. */
  const snapshotFor = (action: number): ActionSnapshot => {
    const spellId = spells.spellInSlot(action);
    if (spellId === null) {
      return emptyAction();
    }
    const row = spellData.spell(spellId);
    // The cooldown, in `GetTime()` seconds. `null` is "none running", which zeroes make
    // `CooldownFrame_SetTimer` hide (`Cooldown.lua` needs start > 0 AND duration > 0 AND enable > 0).
    // The GLOBAL cooldown is in here too: `SpellHandler` puts it on every known spell in the cast's
    // `StartRecoveryCategory` when the server confirms a cast, which is why one cast dims the whole bar.
    const cooldown = spells.cooldownOf(spellId);
    const { usable, notEnoughPower } = usability(spellId);
    return {
      spellId,
      texture: spellData.iconPath(spellId),
      name: row?.name ?? '',
      isAttack: spellId === SPELL_AUTO_ATTACK,
      // Only auto-attack drives "current" today; see `api/actions.ts`'s `IsCurrentAction`.
      isCurrent: spellId === SPELL_AUTO_ATTACK && spells.autoAttackOn,
      cooldownStart: cooldown?.start ?? 0,
      cooldownDuration: cooldown?.duration ?? 0,
      usable,
      notEnoughPower,
      inRange: rangeOf(spellId),
    };
  };

  const same = (a: ActionSnapshot, b: ActionSnapshot): boolean => (
    a.spellId === b.spellId
    && a.texture === b.texture
    && a.name === b.name
    && a.isAttack === b.isAttack
    && a.isCurrent === b.isCurrent
    && a.cooldownStart === b.cooldownStart
    && a.cooldownDuration === b.cooldownDuration
    && a.usable === b.usable
    && a.notEnoughPower === b.notEnoughPower
    && a.inRange === b.inRange
  );

  /**
   * Re-snapshot every slot, push what moved, register any new icon art, then announce once.
   *
   * `ACTIONBAR_SLOT_CHANGED` with arg **0** is the client's own "all slots, re-read everything"
   * (`ActionButton_OnEvent:358-363`: `if ( arg1 == 0 or arg1 == tonumber(self.action) )`). One event for
   * a whole re-read is one fingerprint change instead of 144.
   */
  const pushAll = (): void => {
    const newArt: string[] = [];
    let changed = false;
    for (let action = 1; action <= ACTION_SLOTS; action += 1) {
      const next = snapshotFor(action);
      const previous = getAction(vm, action);
      if (previous !== null && same(previous, next)) {
        continue;
      }
      setAction(vm, action, next);
      changed = true;
      stats.pushes += 1;
      if (next.texture !== null) {
        newArt.push(next.texture);
      }
    }
    if (!changed) {
      return;
    }

    // Register the icon paths BEFORE the event, so `ActionButton_Update`'s `icon:SetTexture(path)` names
    // a key that at least has a def. The fetch is async and lands a moment later; the frame after it
    // lands has a different fingerprint anyway (the sprite resolves from null to a texture), so the icon
    // appears without needing a second event. See the header for why this is not `registerTreeArt`.
    if (newArt.length > 0) {
      for (const path of newArt) {
        art.register(path, { path });
      }
      stats.artLoads += 1;
      void art.load();
    }

    fireEvent(vm, 'ACTIONBAR_SLOT_CHANGED', [0]);
    stats.events += 1;
  };

  /**
   * THE BONUS BAR, and this is what "the twelve buttons were empty" actually was.
   *
   * MEASURED on the live wire for `Gesf` (level-2 human warrior, `SMSG_ACTION_BUTTONS` body 577 B, the
   * five filled words at 0-based slot indices **72, 73, 82, 84, 96**):
   *
   *   1-based 73 = 6603 Auto Attack, 74 = 78 Heroic Strike, 83 = 59752 Every Man for Himself,
   *   85 = 6603, 97 = 6603.
   *
   * Slots 1-72 are the main bar's six pages (`ActionButton.lua:2`, `NUM_ACTIONBAR_PAGES = 6`), so his
   * bar holds NOTHING a main-bar button can address -- and `ActionButton1..12` reading empty slots and
   * hiding themselves is the correct behaviour for that data, not the bug. The three filled blocks
   * (73-84, 85-96, 97-108) are the three BONUS bars, one per warrior stance, and `SpellShapeshiftForm.dbc`
   * says exactly that: form 17 Battle Stance -> `bonusActionBar` 1, 18 Defensive -> 2, 19 Berserker -> 3.
   * The DBC and the wire corroborate each other.
   *
   * So the missing engine value was `GetBonusBarOffset()`, which answered a hard 0. With the real
   * offset, `BonusActionButton1..12` (which carry `self.isBonus = 1`, `BonusActionBarFrame.xml:10`)
   * compute `page = 6 + offset` and read 73-84 (`ActionButton.lua:139-144`), `BonusActionBar_OnEvent`
   * slides the bonus bar up over the main bar, and the icons are the ones the server sent.
   *
   * `UPDATE_BONUS_ACTIONBAR` is the event for it -- `BonusActionBar_OnLoad:10` and the bonus buttons'
   * own `OnLoad` register it, and `ActionButton_OnEvent:369` routes it to `ActionButton_UpdateAction`,
   * which is precisely "recompute my slot, then update me". Fired only on a CHANGE, for the frame-cost
   * reason in this file's header.
   */
  const pushBonusBar = (): void => {
    const player = world.player;
    const form = player?.fields.shapeshiftForm ?? 0;
    stats.form = form;
    const offset = shapeshiftData.bonusBar(form);
    if (offset === null) {
      // The 4.9 KB table is not in yet. Leaving the offset alone is right: 0 is "no bonus bar", the
      // pre-existing state, and `ensureLoaded().then(pushBonusBar)` below re-runs this when it lands.
      return;
    }
    if (!setBonusBarOffset(vm, offset)) {
      return;
    }
    stats.bonusBar = offset;
    stats.pushes += 1;
    fireEvent(vm, 'UPDATE_BONUS_ACTIONBAR');
    stats.events += 1;
  };

  /** Only the auto-attack button's checked state moved, so only the state event is needed. */
  const pushAutoAttack = (): void => {
    let changed = false;
    for (let action = 1; action <= ACTION_SLOTS; action += 1) {
      const previous = getAction(vm, action);
      if (previous === null || previous.spellId !== SPELL_AUTO_ATTACK) {
        continue;
      }
      const next = { ...previous, isCurrent: spells.autoAttackOn };
      if (same(previous, next)) {
        continue;
      }
      setAction(vm, action, next);
      changed = true;
      stats.pushes += 1;
    }
    if (changed) {
      // `ACTIONBAR_UPDATE_STATE` is precisely the checked/flash event
      // (`ActionButton_OnEvent:390` -> `ActionButton_UpdateState`), and it does NOT re-read the texture.
      fireEvent(vm, 'ACTIONBAR_UPDATE_STATE');
      stats.events += 1;
    }
  };

  /**
   * `UseAction` -> the wire.
   *
   * Auto-attack is a SPELL ON A BUTTON in the real client (spell 6603 "Auto Attack"), but it is not cast
   * with `CMSG_CAST_SPELL` -- it toggles melee with `CMSG_ATTACKSWING`/`CMSG_ATTACKSTOP`, which already
   * work. Sending 6603 through `CMSG_CAST_SPELL` would be refused. So the one action that is a spell by
   * identity and an opcode by mechanism is special-cased here, at the one place that knows both.
   */
  const use = (action: number): void => {
    const spellId = spells.spellInSlot(action);
    if (spellId === null) {
      return;
    }
    const target = world.game.objectHandler.combatHandler.selection;
    if (spellId === SPELL_AUTO_ATTACK) {
      if (spells.autoAttackOn) {
        world.game.objectHandler.combatHandler.stopAttack();
      } else if (target !== null) {
        world.game.objectHandler.combatHandler.startAttack(target);
      }
      return;
    }
    spells.castSpell(spellId, target);
  };

  setActionUseHandler(vm, use);

  /**
   * A form change arrives as an ordinary values update on the player, so the bonus bar rides
   * `unit:fields` -- the same event `unit-bridge.ts` listens to. Gated on the player, because a
   * creature's form is nobody's action bar, and `pushBonusBar` diffs anyway.
   */
  /**
   * THE RED / GREY TINT's push: re-evaluate usability and range and fire `ACTIONBAR_UPDATE_USABLE`.
   *
   * `ACTIONBAR_UPDATE_USABLE` and NOT `ACTIONBAR_SLOT_CHANGED`, for the cost reason this file's header
   * gives: `ActionButton_OnEvent:415` routes it to `ActionButton_UpdateUsable` alone, which sets two
   * vertex colours and touches nothing else (`actionbutton.lua:313-328`).
   *
   * Note what `UpdateUsable` actually paints, because the shorthand "the red mask" is misleading:
   * usable -> white, `notEnoughMana` -> **(0.5, 0.5, 1.0), a washed blue**, otherwise -> (0.4, 0.4, 0.4)
   * grey. The only RED in 3.3.5a's action bar is the range indicator, `(1.0, 0.1, 0.1)` on the HotKey
   * region in `ActionButton_OnUpdate:471`. There is no red overlay on the icon anywhere in this build's
   * FrameXML -- grepped.
   */
  const pushUsable = (): void => {
    let changed = false;
    for (let action = 1; action <= ACTION_SLOTS; action += 1) {
      const previous = getAction(vm, action);
      if (previous === null || previous.spellId === 0) {
        continue;
      }
      const { usable, notEnoughPower } = usability(previous.spellId);
      const next = {
        ...previous, usable, notEnoughPower, inRange: rangeOf(previous.spellId),
      };
      if (same(previous, next)) {
        continue;
      }
      setAction(vm, action, next);
      changed = true;
      stats.pushes += 1;
    }
    if (changed) {
      fireEvent(vm, 'ACTIONBAR_UPDATE_USABLE');
      stats.events += 1;
    }
  };

  const onFields = (unit: Unit): void => {
    if (unit === world.player) {
      pushBonusBar();
      // A power change is what makes an ability affordable or not, and it arrives as an ordinary values
      // update. `pushUsable` diffs, so a field update that did not move the power costs one pass over 144
      // slots and fires nothing.
      pushUsable();
    }
  };

  /**
   * THE RANGE POLL, and the one piece of per-frame-ish work this bridge has.
   *
   * Range is a function of POSITION, and nothing emits an event when the player walks. The real client
   * polls it from `ActionButton_OnUpdate` every `TOOLTIP_UPDATE_TIME` (0.2 s, `Constants.lua`), so this
   * polls at the same rate rather than every frame -- and `pushUsable` diffs, so a poll that finds the
   * range unchanged fires no event and dirties no fingerprint. Only a real crossing of the range boundary
   * costs a UI pass, which is a handful per approach rather than 60 a second.
   */
  const RANGE_POLL_MS = 200;
  const rangeTimer = window.setInterval(pushUsable, RANGE_POLL_MS);

  /**
   * A cooldown started or ended: push the two numbers and fire the client's own cooldown event.
   *
   * `ACTIONBAR_UPDATE_COOLDOWN` and NOT `ACTIONBAR_SLOT_CHANGED`, which matters for cost:
   * `ActionButton_OnEvent:396` routes it to `ActionButton_UpdateCooldown` ALONE -- which reads
   * `GetActionCooldown` and calls `CooldownFrame_SetTimer`, and touches no texture, no count and no
   * hotkey. A slot-changed event would re-run the whole `ActionButton_Update` on 12 buttons for a
   * number the sweep pass reads directly.
   *
   * Fired ONCE per cooldown change, not per frame. The sweep itself is animated by the draw pass with no
   * Lua involvement at all (`world-ui.ts#drawSweeps`), which is the whole reason a running cooldown
   * costs no interface re-render.
   */
  const pushCooldowns = (): void => {
    let changed = false;
    for (let action = 1; action <= ACTION_SLOTS; action += 1) {
      const previous = getAction(vm, action);
      if (previous === null || previous.spellId === 0) {
        continue;
      }
      const cooldown = spells.cooldownOf(previous.spellId);
      const next = {
        ...previous,
        cooldownStart: cooldown?.start ?? 0,
        cooldownDuration: cooldown?.duration ?? 0,
      };
      if (same(previous, next)) {
        continue;
      }
      setAction(vm, action, next);
      changed = true;
      stats.pushes += 1;
    }
    if (changed) {
      fireEvent(vm, 'ACTIONBAR_UPDATE_COOLDOWN');
      stats.events += 1;
    }
  };

  /**
   * THE CAST BAR's feed: `SMSG_SPELL_START` -> a cast snapshot -> `UNIT_SPELLCAST_START`.
   *
   * Only OUR OWN casts, and only the `"player"` token. `CastingBarFrame` is constructed with
   * `unit = "player"` (`castingbarframe.xml`) and returns immediately for any other unit
   * (`castingbarframe.lua:65-67`, `if ( arg1 ~= unit ) then return; end`), so a peer's cast has no frame
   * to land on -- `TargetFrameSpellBar` is a separate `CastingBarFrame` on `"target"` and is left for a
   * later round rather than half-fed.
   *
   * An INSTANT cast is skipped, and that is the client's own behaviour rather than a shortcut: a zero
   * `castTime` gives `maxValue = 0`, and `CastingBarFrame_OnUpdate` would divide the spark position by it.
   * The real client sends no `SMSG_SPELL_START` for an instant cast at all -- only `SMSG_SPELL_GO` -- so
   * a `castTimeMs` of 0 here means the server chose to announce a cast with no duration, and there is
   * nothing to fill.
   */
  const onSpellStart = (decoded: {
    caster: string; spellId: number; castTimeMs: number; timerMs: number;
  }): void => {
    if (decoded.caster !== world.player?.guid || decoded.castTimeMs <= 0) {
      return;
    }
    const row = spellData.spell(decoded.spellId);
    // MILLISECONDS on the `GetTime()` clock -- `UnitCastingInfo`'s contract, and the one pair in this
    // runtime that is not in seconds. See `lua/api/casting.ts`.
    //
    // `timerMs` is what REMAINS, not the whole cast, so the start is back-dated by however much of the
    // cast the packet says has already elapsed. For a cast we just began those are equal and the
    // subtraction is a no-op; for a cast already running when we entered the world it is the difference
    // between a bar that starts correctly part-full and one that restarts from zero.
    const nowMs = gameTime() * 1000;
    const elapsedMs = Math.max(0, decoded.castTimeMs - decoded.timerMs);
    const startTimeMs = nowMs - elapsedMs;
    setCast(vm, 'player', {
      name: row?.name ?? '',
      texture: spellData.iconPath(decoded.spellId),
      startTimeMs,
      endTimeMs: startTimeMs + decoded.castTimeMs,
      castID: 0,
      channeling: false,
      // Unsourced: `castFlags`' interrupt bit position in 3.3.5a is not established here, and
      // `CastingBarFrame` is built with `showShield` false for the player's own bar, so the value is not
      // drawn. False rather than a guess.
      notInterruptible: false,
    });
    // Push THEN fire -- `CastingBarFrame_OnEvent` re-reads `UnitCastingInfo` on the first line of its
    // START branch and hides itself if it answers nil.
    fireEvent(vm, 'UNIT_SPELLCAST_START', ['player', row?.name ?? '', 0, 0]);
    stats.events += 1;
  };

  /**
   * The cast ended. `SMSG_SPELL_GO` is the success case and `SMSG_CAST_FAILED` the refusal, and the two
   * fire DIFFERENT events because the frame colours itself differently: `UNIT_SPELLCAST_STOP` turns the
   * bar green and fades it, `UNIT_SPELLCAST_FAILED` turns it red and writes `FAILED` into its text
   * (`castingbarframe.lua:120-160`).
   *
   * The 4th event argument is `castID` and is MATCHED against the frame's own
   * (`select(4, ...) == self.castID`), so it has to be the same 0 the START pushed -- a mismatched id
   * leaves the bar running for ever.
   */
  const endCast = (event: string): void => {
    if (getCast(vm, 'player') === null) {
      return;
    }
    setCast(vm, 'player', null);
    fireEvent(vm, event, ['player', '', 0, 0]);
    stats.events += 1;
  };

  const onSpellGo = (decoded: { caster: string }): void => {
    if (decoded.caster === world.player?.guid) {
      endCast('UNIT_SPELLCAST_STOP');
    }
  };
  const onCastFailed = (): void => endCast('UNIT_SPELLCAST_FAILED');
  /**
   * `SMSG_SPELL_FAILURE` -> `UNIT_SPELLCAST_INTERRUPTED`, which is a DIFFERENT event from FAILED and is
   * why the interrupt is read off its own opcode rather than inferred from the cast bar going quiet.
   * The frame writes `INTERRUPTED` into its text for one and `FAILED` for the other
   * (`castingbarframe.lua:147-153`). Without this a broken cast would leave the bar filling to the end.
   */
  const onSpellFailure = (decoded: { caster: string }): void => {
    if (decoded.caster === world.player?.guid) {
      endCast('UNIT_SPELLCAST_INTERRUPTED');
    }
  };

  spells.on('spellStart', onSpellStart);
  spells.on('spellGo', onSpellGo);
  spells.on('castFailed', onCastFailed);
  spells.on('spellFailure', onSpellFailure);
  spells.on('actionsChanged', pushAll);
  spells.on('spellsChanged', pushAll);
  spells.on('autoAttackChanged', pushAutoAttack);
  spells.on('cooldownsChanged', pushCooldowns);
  world.on('unit:fields', onFields);

  // Both entry packets arrive while the manifest is still loading -- `SMSG_ACTION_BUTTONS` is in the
  // login burst and the FrameXML load takes 8-22 s -- so the first push is made here rather than waited
  // for. Exactly the same reason `unit-bridge.ts` pushes the player on attach.
  pushAll();

  /**
   * THE DBC LOAD, and it happens HERE rather than in the packet handler ON PURPOSE.
   *
   * `Spell.dbc` is 49 MB. Firing its fetch from `SMSG_INITIAL_SPELLS` -- which arrives in the login
   * burst -- put it in contention with `FrameXML.toc`'s 264 small fetches over the same connection and
   * STARVED them: measured, the FrameXML boot did not complete in 240 s and `window.worldRuntime` never
   * appeared, with nothing logged anywhere. This bridge attaches only after the manifest is loaded, so
   * by the time the big fetch starts there is nothing left for it to starve.
   *
   * The bar therefore comes up with the right SHAPE first (buttons shown, icons blank) and the icons
   * land a moment later, when `pushAll` runs again on resolve.
   */
  void spellData.ensureLoaded().then(pushAll);

  // The bonus bar's own table is 4,890 bytes and is deliberately NOT behind the 49 MB one (see
  // `shapeshift-data.ts`): which slots the buttons address must not wait on the icons. Pushed on attach
  // as well, because the player's form byte arrived in his create block long before this attached.
  void shapeshiftData.ensureLoaded().then(pushBonusBar);
  pushBonusBar();

  (window as unknown as Record<string, unknown>).actionBridgeStats = stats;

  return () => {
    window.clearInterval(rangeTimer);
    spells.removeListener('actionsChanged', pushAll);
    spells.removeListener('spellsChanged', pushAll);
    spells.removeListener('autoAttackChanged', pushAutoAttack);
    spells.removeListener('cooldownsChanged', pushCooldowns);
    spells.removeListener('spellStart', onSpellStart);
    spells.removeListener('spellGo', onSpellGo);
    spells.removeListener('castFailed', onCastFailed);
    spells.removeListener('spellFailure', onSpellFailure);
    world.removeListener('unit:fields', onFields);
    delete (window as unknown as Record<string, unknown>).actionBridgeStats;
  };
}
