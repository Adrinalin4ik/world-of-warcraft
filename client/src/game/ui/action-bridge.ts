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
} from './framexml/lua/api/actions';
import { SPELL_AUTO_ATTACK, SpellHandler } from '../../network/game/object/spells';
import { fireEvent } from './framexml/lua/events';
import { spellData } from '../pipeline/dbc/spell-data';
import { LuaVM } from './framexml/lua/vm';

/**
 * Subscribe a VM to the server's action bar. Returns the teardown.
 *
 * `world.session.offline` has no protocol at all, so the caller must not attach this on the offline
 * route -- `world-ui.ts` gates it the same way it gates the unit bridge.
 */
export function attachActionBridge(vm: LuaVM, world: World, art: GlueArt): () => void {
  const spells: SpellHandler = world.game.objectHandler.spellHandler;

  /** How many pushes and events this bridge has made, for the frame-cost measurement. */
  const stats = { pushes: 0, events: 0, artLoads: 0 };

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

  spells.on('actionsChanged', pushAll);
  spells.on('spellsChanged', pushAll);
  spells.on('autoAttackChanged', pushAutoAttack);

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

  (window as unknown as Record<string, unknown>).actionBridgeStats = stats;

  return () => {
    spells.removeListener('actionsChanged', pushAll);
    spells.removeListener('spellsChanged', pushAll);
    spells.removeListener('autoAttackChanged', pushAutoAttack);
    delete (window as unknown as Record<string, unknown>).actionBridgeStats;
  };
}
