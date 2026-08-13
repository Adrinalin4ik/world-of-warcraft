/**
 * THE CURSOR: what the player is carrying between a drag's start and its drop.
 *
 * Six globals were measured nil last round and are the whole reason dragging an ability did nothing:
 * `PickupAction`, `PlaceAction`, `GetCursorInfo`, `ClearCursor`, `CursorHasItem`, `CursorHasSpell`, plus
 * `PickupSpell` for a drag that starts in the spellbook. Like `api/actions.ts` and `api/spells.ts` this
 * file holds state and no world: the WIRE half is `ui/spellbook-bridge.ts`, which owns the place handler.
 *
 * ## The two ends of the gesture are BOTH in the client's own Lua, and that is the point
 *
 * Nothing here decides what a drag means. `ActionBarButtonTemplate` does, in `actionbarframe.xml:18-29`:
 *
 *     <OnDragStart>
 *         if ( LOCK_ACTIONBAR ~= "1" or IsModifiedClick("PICKUPACTION") ) then
 *             PickupAction(self.action);
 *             ActionButton_UpdateState(self);
 *             ActionButton_UpdateFlash(self);
 *         end
 *     </OnDragStart>
 *     <OnReceiveDrag>
 *         PlaceAction(self.action);
 *         ActionButton_UpdateState(self);
 *         ActionButton_UpdateFlash(self);
 *     </OnReceiveDrag>
 *
 * Two things in that were read off the file rather than assumed, and both change the design:
 *
 *  1. **`OnReceiveDrag` has NO `if ( GetCursorInfo() )` guard.** It calls `PlaceAction` unconditionally,
 *     on every drop, including a drop with an empty cursor. So `PlaceAction` must itself do nothing when
 *     the cursor is empty -- if it did not, every stray drag-release onto a button would blank that slot.
 *  2. **A plain drag needs no modifier and no `IsModifiedClick`.** `LOCK_ACTIONBAR` is unset, so
 *     `nil ~= "1"` is true and Lua short-circuits the `or` -- `IsModifiedClick`, which is still a declared
 *     gap, is never reached on this path. That is why the drag works without closing that gap, and it is
 *     worth recording because the obvious reading of the line is the opposite.
 *
 * The spellbook end is `spellbookframe.xml:166-171` -> `SpellButton_OnDrag` (`spellbookframe.lua:391-398`),
 * which calls `PickupSpell(id, SpellBookFrame.bookType)` with a spellbook SLOT -- not a spell id. See
 * `api/spells.ts`'s header on why that distinction is the sharp one in this whole area.
 *
 * ## What `GetCursorInfo` reports, and why there is no `"action"` type
 *
 * 3.3.5a's `GetCursorInfo()` returns a TYPE STRING and up to two payload values; its consumers test the
 * string (`containerframe.lua:697-705` against `"guildbankmoney"`/`"money"`,
 * `paperdollframe.lua:1235-1236` against `"merchant"`). There is no `"action"` type, because picking an
 * action off a bar puts that action's CONTENT on the cursor -- so an action slot holding a spell reports
 * `"spell"`, exactly as a drag out of the spellbook does. The source slot is remembered here but is NOT
 * reported, which is the real engine's behaviour too: it is what makes a bar-to-bar drag a SWAP rather
 * than a copy, and nothing in Lua needs to see it.
 */
import { LuaVM } from '../vm';
import { fireEvent } from '../events';
import { notImplemented } from '../methods/region';
import { BOOKTYPE_SPELL } from './spells';

/** What the cursor is carrying. */
export interface CursorPayload {
  /**
   * Where it came from -- NOT what `GetCursorInfo` reports (that is always `"spell"` here).
   *
   * `'action'` carries a `sourceSlot` and makes a drop a SWAP; `'spell'` came from the book and makes a
   * drop an assignment.
   */
  kind: 'spell' | 'action';
  spellId: number;
  /** The 1-based spellbook (`all`-list) slot, for `GetCursorInfo`'s payload. Null if not in the book. */
  bookSlot: number | null;
  /** For `'action'`: the 1-based action slot it was picked up from. Null for a book drag. */
  sourceSlot: number | null;
  /** The icon path, so the host can draw it under the pointer. Null until `Spell.dbc` lands. */
  texture: string | null;
}

interface CursorState {
  held: CursorPayload | null;
  /**
   * The host's PLACE door. Returns true when the placement happened, and the cursor is cleared only then
   * -- a refused placement (no world, a slot number the server would reject) must leave the player still
   * carrying the ability rather than silently dropping it.
   */
  place: ((destination: number, payload: CursorPayload) => boolean) | null;
  /** Resolves an action slot to what is in it, for `PickupAction`. Null with no host. */
  pick: ((action: number) => CursorPayload | null) | null;
  /** Resolves a spellbook slot to what is in it, for `PickupSpell`. Null with no host. */
  pickSpell: ((slot: number) => CursorPayload | null) | null;
  /**
   * The host's DISCARD door: an action slot to be emptied, both locally and on the server.
   *
   * Only reached by `dropCursorOnWorld` -- see it for why a drop on the world deletes and an abandoned
   * drag does not.
   */
  discard: ((sourceSlot: number) => void) | null;
}

const stateByVm = new WeakMap<LuaVM, CursorState>();

function stateOf(vm: LuaVM): CursorState {
  let state = stateByVm.get(vm);
  if (state === undefined) {
    state = { held: null, place: null, pick: null, pickSpell: null, discard: null };
    stateByVm.set(vm, state);
  }
  return state;
}

/** What the cursor is carrying, for the host's own draw pass. Null when empty. */
export function getCursor(vm: LuaVM): CursorPayload | null {
  return stateOf(vm).held;
}

/** The host's four doors. See `CursorState` for why `place` answers a boolean. */
export function setCursorHandlers(vm: LuaVM, handlers: {
  place: (destination: number, payload: CursorPayload) => boolean;
  pick: (action: number) => CursorPayload | null;
  pickSpell: (slot: number) => CursorPayload | null;
  discard: (sourceSlot: number) => void;
}): void {
  const state = stateOf(vm);
  state.place = handlers.place;
  state.pick = handlers.pick;
  state.pickSpell = handlers.pickSpell;
  state.discard = handlers.discard;
}

/**
 * PUT THE CURSOR DOWN, and the one place that ever empties it.
 *
 * `deleteSource` is the whole difference between the two ways a gesture can end, and both are engine
 * behaviour: grepped across all 264 loaded manifest files, `WorldFrame` declares NO `OnReceiveDrag` and
 * no `OnMouseUp` (`worldframe.xml:23-77`), and no file clears the cursor on Escape either -- the seven
 * `ClearCursor()` call sites are container/equipment/static-popup paths (`containerframe.lua:703,706`,
 * `equipmentmanager.lua:74,95,118,259,324`, `staticpopup.lua:159..1644`). So there is no Lua to run for
 * either exit; the engine is what does it, which is why this lives here and not in a script.
 *
 * The HIDEGRID is fired for the same reason `ClearCursor` fires it -- `ActionButton_ShowGrid` keeps a
 * counter (`actionbutton.lua:340-366`) and every pickup's SHOWGRID needs exactly one partner.
 */
function putDown(vm: LuaVM, deleteSource: boolean): boolean {
  const state = stateOf(vm);
  const held = state.held;
  if (held === null) {
    return false;
  }
  state.held = null;
  if (deleteSource && held.kind === 'action' && held.sourceSlot !== null && state.discard !== null) {
    state.discard(held.sourceSlot);
  }
  fireEvent(vm, 'ACTIONBAR_HIDEGRID');
  return true;
}

/**
 * A DROP THAT LANDED ON THE WORLD: the gesture the owner reported missing -- "I cannot drop the spell
 * to the empty place to discard action or remove the skill from the panel".
 *
 * The real client empties the slot at PICKUP and a drop on the world simply leaves it empty; this client
 * empties it here instead, at the drop, so the visible result of THIS gesture is the same and an
 * abandoned drag still leaves the bar untouched (see `PickupAction`'s note, which stays true). What
 * tells the server is `CMSG_SET_ACTION_BUTTON` with `packedData == 0`, the remove form the opcode
 * already had (`network/game/object/spells.ts#setActionButton`).
 *
 * A payload from the SPELLBOOK has no slot to empty, so this is only the cursor being put down.
 */
export function dropCursorOnWorld(vm: LuaVM): boolean {
  return putDown(vm, true);
}

/**
 * ESCAPE, and it exists because a cursor that cannot be emptied is a trap: "драг ломается если я отпущу
 * мышь во время драга. После этого я больше не могу отпустить захваченный скил."
 *
 * Holding an action after a release on an invalid target is the real client's behaviour (see
 * `input.ts`'s drop branch), so what was broken was never the holding -- it was that nothing could end
 * it. This is `ClearCursor`'s semantics exactly, NOT the deleting form: an abandoned drag must not
 * destroy a slot, so the ability goes back to being just where it still is on the bar.
 *
 * UNSOURCED, and stated as such: the 264 manifest files contain no Escape handling for the cursor at all
 * (it is engine, like the drop above), so "Escape puts the cursor down" is taken from the real client's
 * observed behaviour and not from a file in this build.
 */
export function cancelCursor(vm: LuaVM): boolean {
  return putDown(vm, false);
}

export function installCursorApi(vm: LuaVM): void {
  const state = stateOf(vm);

  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  const slotOf = (value: unknown): number | null => {
    const slot = Number(value);
    return Number.isFinite(slot) && slot >= 1 ? Math.floor(slot) : null;
  };

  /**
   * THE EMPTY-SLOT GRID, and it is what makes an ability droppable on a slot that has nothing in it.
   *
   * `ActionButton_Update` HIDES a button with no action, so it is not in the draw list and `hit.ts` cannot
   * find it -- a drop over an empty slot landed on the world. The real client reveals the empty buttons for
   * the length of the drag, and the mechanism is a pair of events:
   *
   *     ActionButton.lua:92-93   self:RegisterEvent("ACTIONBAR_SHOWGRID");
   *                              self:RegisterEvent("ACTIONBAR_HIDEGRID");
   *     ActionButton.lua:373-380 ACTIONBAR_SHOWGRID -> ActionButton_ShowGrid(self)
   *                              ACTIONBAR_HIDEGRID -> ActionButton_HideGrid(self)
   *
   * **The ENGINE is what fires them**, which is why they belong here: grepped across all 264 loaded
   * manifest files, `actionbutton.lua` is the ONLY file that mentions either name, and it only registers
   * and handles them. Nothing in the client's own Lua raises them, so nothing did.
   *
   * ONE of each per gesture, which keeps `ActionButton_ShowGrid`'s counter balanced -- it does
   * `SetAttribute("showgrid", GetAttribute("showgrid") + 1)` and `HideGrid` decrements, hiding the button
   * only back at zero (`actionbutton.lua:340-366`). So a pickup fires SHOWGRID once and every way of
   * putting the ability down again -- a successful `PlaceAction` or a `ClearCursor` -- fires HIDEGRID once.
   */
  const grid = (show: boolean): void => {
    fireEvent(vm, show ? 'ACTIONBAR_SHOWGRID' : 'ACTIONBAR_HIDEGRID');
  };

  /**
   * `PickupAction(action)` -- start carrying whatever is in an action slot.
   *
   * **The source slot is deliberately NOT emptied here, and that is a stated deviation from the real
   * client rather than an oversight.** The real client blanks the slot the instant you start dragging, and
   * dropping the ability on the world DELETES it from the bar. Both are left out: the visible difference
   * is that the source icon stays put for the length of the drag, and an abandoned drag leaves the bar
   * exactly as it was instead of silently destroying a slot. A swap still ends correct, because
   * `PlaceAction` writes both ends. See `ClearCursor` for the other half of this decision.
   *
   * An EMPTY slot picks up nothing and leaves the cursor alone -- `HasAction` is false there, so
   * `ActionButton_Update` has already hidden that button and a drag cannot start on it anyway.
   */
  fn('PickupAction', (args) => {
    const action = slotOf(args[0]);
    if (action === null || state.pick === null) {
      return [];
    }
    const payload = state.pick(action);
    if (payload !== null) {
      state.held = payload;
      // Reveal the empty slots -- see `grid`. Only on a real pickup: a pickup that found nothing has
      // started no drag, and an unbalanced SHOWGRID would leave the grid up for good.
      grid(true);
    }
    return [];
  });

  /**
   * `PickupSpell(slot, bookType)` -- start carrying a spell out of the spellbook.
   *
   * `slot` is a spellbook slot (`spellbookframe.lua:392` passes `SpellBook_GetSpellID(self:GetID())`),
   * NOT a spell id. A non-spell book type carries nothing, for the reason `api/spells.ts#entryOf` gives.
   */
  fn('PickupSpell', (args) => {
    const slot = slotOf(args[0]);
    const bookType = args[1];
    if (slot === null || state.pickSpell === null) {
      return [];
    }
    if (typeof bookType === 'string' && bookType !== BOOKTYPE_SPELL) {
      return [];
    }
    const payload = state.pickSpell(slot);
    if (payload !== null) {
      state.held = payload;
      grid(true);
    }
    return [];
  });

  /**
   * `PlaceAction(action)` -- drop what the cursor is carrying into an action slot.
   *
   * **Does nothing with an empty cursor, and that is load-bearing, not defensive:**
   * `actionbarframe.xml:26` calls this on EVERY `OnReceiveDrag` with no `GetCursorInfo` guard of its own
   * (see the file header), so every drag-release that lands on an action button arrives here whether or
   * not the player is carrying anything.
   *
   * The cursor is cleared only when the host reports the placement went through, so a refusal leaves the
   * ability in hand rather than losing it.
   */
  fn('PlaceAction', (args) => {
    const action = slotOf(args[0]);
    const held = state.held;
    if (action === null || held === null || state.place === null) {
      return [];
    }
    if (state.place(action, held)) {
      state.held = null;
      // The gesture is over, so the revealed empty slots go away again. Paired with the SHOWGRID that
      // `PickupAction`/`PickupSpell` fired; a REFUSED placement leaves both the ability and the grid up,
      // which is right -- the player is still carrying it.
      grid(false);
    }
    return [];
  });

  /**
   * `GetCursorInfo()` -> `type, data1, data2`, or nothing when the cursor is empty.
   *
   * Always `"spell"` for anything this client can carry -- see the header on why there is no `"action"`
   * type. `data1` is the spellbook slot and `data2` the book type, which is the pair `GetSpellName` and
   * `GetSpellTexture` take, so a consumer can name what is on the cursor with the two arguments it gets.
   *
   * `data1` is nil for a spell that is on the bar but NOT in the book -- possible, because the bar's
   * contents come from `SMSG_ACTION_BUTTONS` and the book's from `SMSG_INITIAL_SPELLS` and the server can
   * leave a stale action word for a spell the character no longer knows. Nil rather than a fabricated
   * slot: a wrong slot number would name a different spell.
   */
  fn('GetCursorInfo', () => {
    const held = state.held;
    if (held === null) {
      return [];
    }
    return ['spell', held.bookSlot, BOOKTYPE_SPELL];
  });

  /**
   * `ClearCursor()` -- stop carrying, WITHOUT deleting.
   *
   * In the real client the slot is already empty by the time this runs (the pickup blanked it), so
   * "clear" and "delete" are the same act there and different here: this client blanks nothing at
   * pickup, so `ClearCursor` leaves the ability where it still is on the bar. The DELETING form is
   * `dropCursorOnWorld`, which is the gesture that means "throw this away".
   *
   * `putDown` is shared with both engine exits so the three cannot drift, and it no-ops on an empty
   * cursor -- which keeps the SHOWGRID/HIDEGRID counter balanced, since several of the client's own
   * handlers call `ClearCursor` defensively on a cursor that holds nothing.
   */
  fn('ClearCursor', () => {
    cancelCursor(vm);
    return [];
  });

  /**
   * `CursorHasSpell()` / `CursorHasItem()`.
   *
   * `CursorHasItem` is FALSE always, and it is a true answer rather than a stub: nothing in this client
   * can put an item on the cursor. There is no bag/inventory feed, `ACTION_BUTTON_ITEM` slots are named
   * and skipped by `network/game/object/spells.ts#spellInSlot`, and `PickupContainerItem` /
   * `PickupInventoryItem` do not exist -- so the set of things that could make this true is empty.
   */
  fn('CursorHasSpell', () => [state.held !== null]);
  fn('CursorHasItem', () => [false]);

  /**
   * A declared gap: money on the cursor, which `ContainerFrame` and `MerchantFrame` both test for
   * (`containerframe.lua:697-705`). Registered by name so the load report carries it, through the same
   * adaptation `api/actions.ts:367-373` documents.
   */
  const stub = notImplemented(
    'DropCursorMoney',
    'no money feed: nothing in this client can put currency on the cursor, so the guild-bank and '
      + 'merchant branches that test for it are unreachable',
    [],
  );
  fn('DropCursorMoney', () => stub(null as never, 0, []));
}
