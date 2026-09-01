/**
 * THE SELECTION AND ESCAPE GLOBALS -- the engine half of `TargetNearestEnemy`, `ClearTarget` and
 * `SpellStopCasting`.
 *
 * ## Escape's order is the client's own, and it is not the one the brief for this round stated
 *
 * `Bindings.xml:662-664` binds `TOGGLEGAMEMENU` to one statement, `ToggleGameMenu()`, and that
 * function is a single `elseif` chain (`uiparent.lua:2868-2903`). Reading it top to bottom, the legs
 * that matter here are, IN THIS ORDER:
 *
 *      2872  securecall("StaticPopup_EscapePressed")     -- a popup first
 *      2873  GameMenuFrame:IsShown()                     -- then the menu itself
 *      2876-2887  Help / Video / Audio / Interface options / TimeManager / MultiCastFlyout
 *      2890  securecall("FCFDockOverflow_CloseLists")
 *      2891  securecall("CloseMenus")                    -- open DROPDOWNS
 *      2893  SpellStopCasting()                          -- CANCEL THE CAST
 *      2894  SpellStopTargeting()
 *      2895  securecall("CloseAllWindows")               -- CLOSE THE WINDOWS
 *      2896  ClearTarget() and (not UnitIsCharmed("player"))   -- CLEAR THE TARGET
 *      2899  else ShowUIPanel(GameMenuFrame)
 *
 * So **the cast is cancelled BEFORE the windows are closed**, not after: the brief's "close an open
 * window, cancel a cast, and clear the target" has the first two the wrong way round. Dropdown menus
 * do come before the cast (`CloseMenus`, :2891) and panel windows come after it, which is probably
 * where that reading came from. The order below is the file's.
 *
 * Every leg is the client's own Lua except the four engine globals this file supplies, and the whole
 * chain is one `elseif` -- so **each of them must return a truthy value only when it actually did
 * something**. A `SpellStopCasting` that always answered 1 would make Escape never close a window,
 * never clear the target and never open the game menu. That is the source for `ClearTarget`'s return
 * value, which is otherwise unobservable: the chain reads `ClearTarget() and (not
 * UnitIsCharmed("player"))`, so it has to be falsy with no target or the menu could never open.
 */
import type World from '../world';
import { nearestEnemy, emptyScanReport, ScanReport } from '../world/scan';
import { LuaVM } from './framexml/lua/vm';
import { notImplemented } from './framexml/lua/methods/region';
import { getCast, setCast } from './framexml/lua/api/casting';
import { fireEvent } from './framexml/lua/events';
import { setCastBarTeardown } from '../classes/cast-cancel';

/**
 * Register the selection globals against a live world. Returns the teardown.
 *
 * Attached beside `attachUnitBridge` and for the same reason: these need a `World`, and
 * `installUnitsApi` (which runs during the boot, before there is one) cannot have it.
 */
export function attachTargetBridge(vm: LuaVM, world: World): () => void {
  /** Every press's verdict, for `window.worldScan`. One row, overwritten -- a log would grow. */
  let lastScan: ScanReport = emptyScanReport();

  /**
   * `TargetNearestEnemy([reverse])` -- the TAB command (`Bindings.xml:456-461`).
   *
   * The geometry is `world/scan.ts` (the 3.3.5a cone). `setTarget` is the only door to the wire, so a
   * TAB and a click commit identically.
   *
   * **A DECLARED DEVIATION, shared with the click and pre-dating this file**: the reference's `commit`
   * (`target/scan.rs:456-484`, byte-read from `SetSelection 0x493540`) is **stop -> select -> re-swing**
   * when the selection changes WHILE AUTO-ATTACKING -- `CMSG_ATTACKSTOP`, then the selection, then
   * `CMSG_ATTACKSWING` at the new target. `World#setTarget` sends the selection alone, so a TAB (or a
   * click) mid-fight moves the target and leaves the swing where it was. Naming it here rather than
   * fixing it silently: it needs `Engaged` state at the moment of the switch and a hostile to verify
   * against, and Northshire is neutral.
   */
  vm.registerFunction('TargetNearestEnemy', (args) => {
    // LUA TRUTHINESS, not `=== true`: the binding passes the NUMBER 1 (`Bindings.xml:460`), and 0
    // would be true in Lua as well. The same `luaFlag` rule the wrap setters follow.
    const reverse = args[0] !== undefined && args[0] !== null && args[0] !== false;
    const report = emptyScanReport();
    const unit = nearestEnemy(world, reverse, report);
    lastScan = report;
    if (unit !== null) {
      world.setTarget(unit);
    }
    return [];
  });

  /**
   * `ClearTarget()` -- and its return value is load-bearing; see the header.
   *
   * Truthy only when there was something to clear. `world.setTarget(null)` is what sends
   * `CMSG_SET_SELECTION 0` and fires `PLAYER_TARGET_CHANGED`.
   */
  vm.registerFunction('ClearTarget', () => {
    if (world.target === null) {
      return [null];
    }
    world.setTarget(null);
    return [1];
  });

  /**
   * `SpellStopCasting()` -- `CMSG_CANCEL_CAST` (0x12F), and truthy only when a cast was in flight.
   *
   * The in-flight cast is the SAME snapshot `UnitCastingInfo` answers from (`api/casting.ts`), which
   * is what makes this agree with the bar the player can see: if there is no bar there is nothing to
   * cancel, and Escape falls through to the next leg.
   *
   * The local end is closed here rather than waited for. The server may echo `SMSG_SPELL_FAILURE`
   * (0x133) for a cancelled cast and may not; `action-bridge.ts#endCast` returns early once the
   * snapshot is gone, so an echo that does arrive is a no-op rather than a second event.
   * `UNIT_SPELLCAST_INTERRUPTED` is the event a cast that stopped without completing raises, and it
   * is what puts `INTERRUPTED` in the bar's text (`castingbarframe.lua:147-153`).
   */
  vm.registerFunction('SpellStopCasting', () => {
    const spells = world.game.objectHandler.spellHandler;
    const cast = getCast(vm, 'player');
    // THE SNAPSHOT IS NOT THE ONLY WAY TO BE CASTING. It is created by `SMSG_SPELL_START`, so for the
    // length of the send -> START round trip a cast is genuinely in flight with no bar and no snapshot
    // -- and Escape pressed there used to answer nil and fall through to closing a window instead. The
    // in-flight guard covers exactly that window because it is armed on the SEND
    // (`game/classes/pending-cast.ts`), and the reference reads its own equivalent first for the same
    // reason (`ui_cast.rs:270`, `inflight(&pending, ...)`).
    const guarded = spells.currentCast();
    if (cast === null && guarded === null) {
      return [null];
    }
    if (cast !== null) {
      setCast(vm, 'player', null);
      fireEvent(vm, 'UNIT_SPELLCAST_INTERRUPTED', ['player', cast.name, 0, cast.castID]);
    }
    // The snapshot's spell id when there is one -- it is the cast the player can see -- and the guard's
    // otherwise. `castID` is 0 for every cast this client sends, which is what `castSpell` writes.
    const spellId = cast !== null ? cast.spellId : (guarded as number);
    if (!world.session.offline) {
      spells.cancelCast(spellId, cast !== null ? cast.castID : 0);
    } else {
      // No wire offline, but the guard must still open or the next press is refused as a duplicate.
      spells.releaseCastGuard(spellId);
    }
    // Escape bypasses the movement `InterruptFlags` gate -- the reference's `SpellStopCasting ->
    // AbortCast` has no flags test at all, "the gate belongs to the movement path alone"
    // (`ui_cast.rs:363-365`). So no gate here, unlike `cast-cancel.ts`.
    //
    // The pose has to be handed back for the same reason the movement path does it: it is a LOOP and
    // nothing else will ever take the latch off it.
    spells.releaseCastPose(world.player?.guid ?? null, spellId);
    return [1];
  });

  /**
   * The three gaps this chain reaches, DECLARED so the load report names them and so each returns a
   * FALSY value -- which is what lets Escape walk past them to the leg that can act.
   *
   *  - `SpellStopTargeting` (`uiparent.lua:2894`): there is no spell-targeting cursor in this client.
   *    `CMSG_CAST_SPELL` goes out with the current selection and no reticle is ever armed, so there is
   *    never a targeting mode to leave.
   *  - `UnitIsCharmed` (`:2896`): no charm state is decoded. False is the answer for every unit on
   *    this server today, and it is the value that lets the target clear.
   *  - `SetUIVisibility` (`:2871`): hiding the whole interface (ALT-Z) is not implemented. Reached
   *    only from the first leg, which needs `UIParent` already hidden -- something nothing here does.
   */
  const gaps: Array<[string, string, unknown[]]> = [
    ['SpellStopTargeting', 'no spell-targeting cursor exists: a cast goes out with the current '
      + 'selection and no reticle is ever armed', []],
    ['UnitIsCharmed', 'no charm state is decoded from the update fields', [false]],
    ['SetUIVisibility', 'hiding the whole interface is not implemented', []],
    ['TargetNearestFriend', 'the friendly scan is not written: TARGETNEARESTFRIEND has no default key '
      + 'and nothing in the manifest calls it', []],
  ];
  for (const [name, reason, results] of gaps) {
    const stub = notImplemented(name, reason, results);
    vm.registerFunction(name, () => stub(null as never, 0, []));
  }

  /**
   * THE MOVEMENT CANCEL'S BAR HALF. `game/classes/cast-cancel.ts` does the wire, the guard and the
   * pose -- none of which needs a VM -- and calls this for the part that does.
   *
   * Registered here rather than in the cancel module because this is the file that already owns the
   * same teardown for Escape (`SpellStopCasting` above); the two now differ only in what triggers
   * them, which is where the difference belongs.
   *
   * **The event is `UNIT_SPELLCAST_INTERRUPTED` and not `_STOP`**, and the reference argues the point
   * at length (`ui_cast.rs:377-394`): the client's own local event is the SILENT stop, but what the
   * player actually sees in the real client is the RED "Interrupted" bar, because the server answers
   * the cancel with a failing result and the client repaints on that echo. Firing the interrupt locally
   * reproduces the visible sequence at zero round trip. `castingbarframe.lua:147-153` is what writes
   * the word.
   *
   * The snapshot may legitimately be absent -- a cancel inside the send -> `SMSG_SPELL_START` window
   * has a guard but no bar yet -- and then there is nothing to tear down and no event worth firing.
   */
  setCastBarTeardown((spellId) => {
    const cast = getCast(vm, 'player');
    if (cast === null || cast.spellId !== spellId) {
      return;
    }
    setCast(vm, 'player', null);
    fireEvent(vm, 'UNIT_SPELLCAST_INTERRUPTED', ['player', cast.name, 0, cast.castID]);
  });

  (window as unknown as Record<string, unknown>).worldScan = () => lastScan;

  return () => {
    setCastBarTeardown(null);
    delete (window as unknown as Record<string, unknown>).worldScan;
  };
}
