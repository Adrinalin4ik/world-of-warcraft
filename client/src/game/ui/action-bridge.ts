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

  /** Build the snapshot for one 1-based slot from the handler and the DBC tables. */
  const snapshotFor = (action: number): ActionSnapshot => {
    const spellId = spells.spellInSlot(action);
    if (spellId === null) {
      return emptyAction();
    }
    const row = spellData.spell(spellId);
    return {
      spellId,
      texture: spellData.iconPath(spellId),
      name: row?.name ?? '',
      isAttack: spellId === SPELL_AUTO_ATTACK,
      // Only auto-attack drives "current" today; see `api/actions.ts`'s `IsCurrentAction`.
      isCurrent: spellId === SPELL_AUTO_ATTACK && spells.autoAttackOn,
      // No per-cast cooldown feed exists yet, and `SMSG_INITIAL_SPELLS` reported none on entry. Zeroes
      // make `CooldownFrame_SetTimer` hide the sweep, which is the honest answer -- see
      // `framexml/lua/methods/cooldown.ts` for why nothing is drawn even when a cooldown IS known.
      cooldownStart: 0,
      cooldownDuration: 0,
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
  const onFields = (unit: Unit): void => {
    if (unit === world.player) {
      pushBonusBar();
    }
  };

  spells.on('actionsChanged', pushAll);
  spells.on('spellsChanged', pushAll);
  spells.on('autoAttackChanged', pushAutoAttack);
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
    spells.removeListener('actionsChanged', pushAll);
    spells.removeListener('spellsChanged', pushAll);
    spells.removeListener('autoAttackChanged', pushAutoAttack);
    world.removeListener('unit:fields', onFields);
    delete (window as unknown as Record<string, unknown>).actionBridgeStats;
  };
}
