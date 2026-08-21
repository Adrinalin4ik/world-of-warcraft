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
 *
 * ## THE ITEM ARM, and why it is one payload space rather than a second cursor
 *
 * The owner reported "drag and drop не работает" for bags and the character window. The gap was never the
 * gesture -- `ui/input.ts` has driven `OnDragStart`/`OnReceiveDrag` since the action-bar round -- it was
 * that `PickupContainerItem` and `PickupInventoryItem` had nowhere to put an item, so the LEFT arm of
 * `ContainerFrameItemButton_OnClick` (`containerframe.lua:715`) and of
 * `PaperDollItemSlotButton_OnClick` (`paperdollframe.lua:1237`) both ended in nothing.
 *
 * `CursorPayload` grew a third `kind` rather than gaining a parallel mechanism, and that is the
 * reference's own shape: benilla's `CursorPayload` is one enum with `Item`/`Spell`/`Action` arms
 * (`benilla-ui/src/script/cursor.rs:47-52`) precisely so "sounds, `CURSOR_UPDATE`, grid events, and lock
 * display can't drift apart per window" (its own words, `cursor.rs:4-6`). One consequence is free here:
 * `world-ui.ts#drawCursorIcon` already draws `held.texture` at the pointer, so an item's icon rides the
 * cursor with no drawing code at all.
 *
 * The item arm's TRANSITIONS live in `ui/container-bridge.ts`, because every one of them needs the
 * world -- the descriptor read that resolves a slot to an item, and the socket that tells the server.
 * What lives here is the state, the type, and the four globals that only need to READ it
 * (`CursorHasItem`, `CursorHasSpell`, `GetCursorInfo`, `ClearCursor`).
 */
import { LuaVM } from '../vm';
import { fireEvent } from '../events';
import { notImplemented } from '../methods/region';
import { BOOKTYPE_SPELL } from './spells';

/**
 * WHERE AN ITEM WAS PICKED UP FROM, which is what makes a drop a move rather than a copy.
 *
 * `bag` is a live-API container id -- 0 the backpack, 1..4 an equipped bag -- or the
 * `EQUIPMENT_BAG` sentinel that folds the player's own worn slots into the same space, which is the
 * reference's design and its reasoning: one `match` on `bag` can never confuse the two spaces
 * (`benilla-ui/src/script/cursor.rs:26-36`). The sentinel's value and the bag/slot -> wire mapping both
 * live in `ui/container-bridge.ts`, which is the only place that needs them.
 */
export interface CursorItemSource {
  /** 0 = backpack, 1..4 = an equipped bag, `EQUIPMENT_BAG` = a worn slot. */
  bag: number;
  /** 1-based slot within `bag`; for `EQUIPMENT_BAG` it is `GetInventorySlotInfo`'s own 1-based id. */
  slot: number;
  /** The template entry -- `GetCursorInfo`'s `itemID`. */
  itemId: number;
  /** The item link -- `GetCursorInfo`'s `itemLink`. Null when the template has not landed. */
  link: string | null;
  /**
   * The plain name and the quality, captured AT PICKUP for `DELETE_ITEM_CONFIRM`.
   *
   * The event's two arguments are the `%s` of `DELETE_ITEM`/`DELETE_GOOD_ITEM` and the number
   * `UIParent_OnEvent` compares against 3 to choose between them (`uiparent.lua:609-616`). Carried on
   * the payload rather than looked up at the drop for the reason the reference gives for the same field
   * -- "carried so DELETE_ITEM_CONFIRM (a world drop) can report it without a container round-trip"
   * (`benilla-ui/src/script/cursor.rs:72-74`) -- and because by the time the popup's Yes is clicked the
   * source slot may already be locked.
   */
  name: string | null;
  quality: number;
  /**
   * The 1-based inventory slots this item may be EQUIPPED into, empty when it is not equippable.
   *
   * Captured at PICKUP rather than recomputed at the drop, exactly as the reference does
   * (`cursor.rs:76-81`), so `CursorCanGoInSlot` can answer `CURSOR_UPDATE`'s highlight without a
   * second template lookup per slot per event.
   */
  equipSlots: number[];

  /**
   * How many of the stack are on the cursor, when this is a **partial** pick-up. Absent = the whole
   * stack.
   *
   * **The payload could not express this before, and that was the actual blocker for splitting a
   * stack** -- not the modifier (already resolved) and not the dialogue (the client's own, and already
   * working at a vendor). `SplitContainerItem(bag, slot, count)` lifts `count` items onto the cursor
   * and the DROP is what tells the server; without a count on the payload the drop had no way to know
   * it was moving part of a stack rather than all of it, and would have sent `CMSG_SWAP_ITEM` and moved
   * the lot.
   *
   * It is deliberately OPTIONAL rather than defaulted to the stack size: `container-bridge.ts#sendMove`
   * branches on its PRESENCE to choose between `CMSG_SWAP_ITEM` and `CMSG_SPLIT_ITEM`, so "absent"
   * carries the meaning "this is a whole-stack move" that a number could not.
   *
   * NOT reported by `GetCursorInfo`, which answers `type, itemID, itemLink` for an item and has no
   * count in its contract.
   */
  splitCount?: number;
}

/** What the cursor is carrying. */
export interface CursorPayload {
  /**
   * Where it came from -- NOT what `GetCursorInfo` reports (that is `"spell"` for the first two).
   *
   * `'action'` carries a `sourceSlot` and makes a drop a SWAP; `'spell'` came from the book and makes a
   * drop an assignment; `'item'` carries `item` and reports `"item"`.
   */
  kind: 'spell' | 'action' | 'item';
  /** 0 for an `'item'` payload: an item is not a spell and nothing reads this on that arm. */
  spellId: number;
  /** The 1-based spellbook (`all`-list) slot, for `GetCursorInfo`'s payload. Null if not in the book. */
  bookSlot: number | null;
  /** For `'action'`: the 1-based action slot it was picked up from. Null for a book drag. */
  sourceSlot: number | null;
  /** The icon path, so the host can draw it under the pointer. Null until `Spell.dbc` lands. */
  texture: string | null;
  /** Set on, and only on, `kind === 'item'`. See `CursorItemSource`. */
  item?: CursorItemSource;
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

/**
 * PUT AN ITEM ON THE CURSOR, or take it off -- the item arm's one writer.
 *
 * `ui/container-bridge.ts` owns every item transition because every one of them needs the world (see
 * the header). It writes through here rather than holding its own state so that `CursorHasItem`,
 * `GetCursorInfo`, `ClearCursor`, Escape, the world drop and `drawCursorIcon` all keep reading the ONE
 * payload -- which is the whole reason the reference keeps a single enum rather than a cursor per
 * window (`benilla-ui/src/script/cursor.rs:4-6`).
 *
 * `CURSOR_UPDATE` is fired here, on every transition including a clear, because that is what the event
 * means: `PaperDollItemSlotButton_OnEvent` answers it by asking `CursorCanGoInSlot(self:GetID())` and
 * locking or unlocking its highlight (`paperdollframe.lua:1203-1208`), so a pickup that did not fire it
 * would leave every slot un-highlighted and a clear that did not would leave them all lit.
 */
export function setCursorItem(vm: LuaVM, payload: CursorPayload | null): void {
  const state = stateOf(vm);
  state.held = payload;
  fireEvent(vm, 'CURSOR_UPDATE');
}

/** The item on the cursor, or null -- including null when the cursor holds a spell or an action. */
export function getCursorItem(vm: LuaVM): CursorItemSource | null {
  const held = stateOf(vm).held;
  return held !== null && held.kind === 'item' ? held.item ?? null : null;
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
  // HIDEGRID ONLY FOR A SPELL OR AN ACTION, and this is a SELF-REVIEW FIX rather than a nicety.
  // `ActionButton_ShowGrid` keeps a COUNTER (`actionbutton.lua:340-366`) and hides the button only back
  // at zero, so every HIDEGRID needs a partner SHOWGRID. An item pickup fires no SHOWGRID -- `PlaceAction`
  // refuses an item payload, so revealing the empty bar slots would invite a drop that does nothing --
  // and firing HIDEGRID here anyway would have driven that counter NEGATIVE. The next real ability pickup
  // would then have raised it to zero or below and shown no grid at all: dragging one item and pressing
  // Escape would have broken the action bar's empty-slot grid for the rest of the session.
  if (held.kind !== 'item') {
    fireEvent(vm, 'ACTIONBAR_HIDEGRID');
  }
  // Every payload transition fires this -- see `setCursorItem`. An ITEM put down here is put back, never
  // destroyed: `deleteSource` is the ACTION arm's meaning only. See `dropCursorOnWorld`.
  fireEvent(vm, 'CURSOR_UPDATE');
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
 *
 * **AN ITEM DROPPED ON THE WORLD ASKS FIRST AND DESTROYS NOTHING HERE.** It fires
 * `DELETE_ITEM_CONFIRM(name, quality)` and **leaves the item on the cursor**, which is the whole of the
 * engine's part: `UIParent_OnEvent` answers that event by choosing between the two static popups on
 * `arg2 >= 3` (`uiparent.lua:609-616`), and only the popup's own `OnAccept` calls `DeleteCursorItem`
 * (`staticpopup.lua:1576-1578`, `:1600-1602`). Cancel calls `ClearCursor`, and the dialog's `OnUpdate`
 * hides itself the moment `CursorHasItem()` goes false -- so keeping the item held is not incidental,
 * it is what the client's own dialogue is written against.
 *
 * **The confirmation therefore GATES the destroy and can never follow it**, which matters more here
 * than anywhere else in this client: it is the one action a player cannot undo. An earlier version of
 * this function put the item back instead, on the grounds that nothing opened the popup; the popup
 * opens now, so the put-back would silently swallow the gesture.
 *
 * A payload from the SPELLBOOK or the BAR still takes `deleteSource` -- see `putDown`.
 */
export function dropCursorOnWorld(vm: LuaVM): boolean {
  const held = stateOf(vm).held;
  if (held !== null && held.kind === 'item') {
    // ASK, and hold on to it. `arg1` is the `%s` of "Do you want to destroy %s?" and `arg2` is the
    // quality `UIParent_OnEvent` tests against 3. A null name still fires: the dialogue with an empty
    // `%s` is a worse prompt but a far better outcome than a silent destroy or a silent no-op.
    fireEvent(vm, 'DELETE_ITEM_CONFIRM', [held.item?.name ?? '', held.item?.quality ?? 0]);
    return true;
  }
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
    if (held.kind === 'item') {
      // `"item", itemID, itemLink` -- the 3.3.5a shape. `PaperDollItemSlotButton_OnClick` compares the
      // first return against `"merchant"` (`paperdollframe.lua:1234`) and `ContainerFrameItemButton_OnClick`
      // against `"guildbankmoney"`/`"money"`/`"merchant"` (`containerframe.lua:697-707`), so the string is
      // what the client's own branches key on; the two payload values are what
      // `HandleModifiedItemClick` and the chat-link path read.
      return ['item', held.item?.itemId ?? 0, held.item?.link ?? null];
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
   * `CursorHasSpell()` / `CursorHasItem()` -- one payload space, so these are the two arms of one test.
   *
   * `CursorHasItem` was FALSE ALWAYS and the comment here argued that this was a true answer because
   * nothing could put an item on the cursor. That is no longer the case: `ui/container-bridge.ts`'s
   * `PickupContainerItem`/`PickupInventoryItem` do exactly that. `ContainerFrameItemButton_OnClick`
   * (`containerframe.lua:716`) and `PaperDollItemSlotButton_OnClick` (`paperdollframe.lua:1238`) both
   * test it immediately after their pickup, so a stale `false` here would have made the pickup invisible
   * to the client's own Lua even with the payload set.
   */
  fn('CursorHasSpell', () => [state.held !== null && state.held.kind !== 'item']);
  fn('CursorHasItem', () => [state.held !== null && state.held.kind === 'item']);

  /**
   * `GetCursorMoney()` -- 0, and a TRUE answer for the same reason `CursorHasItem` is false: nothing in
   * this client can put currency on the cursor (`DropCursorMoney` just below is the declared gap that
   * says so). 0 is what the real client answers with an empty cursor.
   *
   * ITS ABSENCE WAS BLOCKING EVERY CONTAINER FRAME, which is why it is here rather than left out.
   * `MoneyFrame.lua:19` calls it at `MoneyFrame_OnLoad`, and every one of the thirteen
   * `ContainerFrame<n>MoneyFrame` regions raised
   * `attempt to call a nil value (global 'GetCursorMoney')` at load -- measured, thirteen errors in the
   * world load report, one per bag frame.
   */
  fn('GetCursorMoney', () => [0]);

  /**
   * `PutItemInBackpack()` / `PutItemInBag(inventorySlot)` -> whether an item was PUT DOWN.
   *
   * **FALSE, and these two nils were the whole of "лутать можно, а сумки открыть нельзя".** Measured
   * live, not reasoned about: `BackpackButton_OnClick` is
   * `if ( not PutItemInBackpack() ) then ToggleBackpack() end`
   * (`mainmenubarbagbuttons.lua:52-57`) and `BagSlotButton_OnClick` is the same shape with
   * `PutItemInBag(id)` (`:15-23`) -- so with the first call nil BOTH handlers threw on their FIRST
   * line and the toggle underneath was never reached. Probed:
   *
   *     ToggleBackpack()              ok=true   frames 0 -> 1
   *     BackpackButton_OnClick        ok=false  ...nil value (global 'PutItemInBackpack')
   *     BagSlotButton_OnClick(bag0)   ok=false  ...nil value (global 'PutItemInBag')
   *
   * The DATA was never the problem and neither was the frame: `ToggleBackpack()`, `OpenAllBags()` and
   * the `TOGGLEBACKPACK` key binding all already opened the bag. Only the MOUSE routes were dead,
   * which is exactly the shape of "I can loot but I cannot open a bag".
   *
   * **THESE TWO ARE THE EMPTY-CURSOR ANSWER ONLY.** They must exist BEFORE the manifest runs (the
   * measurement above is why), and at that point there is no world to place into, so an empty-handed
   * `false` is all this file can honestly say. `ui/container-bridge.ts` RE-REGISTERS both with the real
   * placement once it attaches, which is the same override `PickupContainerItem` takes -- see its own
   * note there. The `false` branch is still what lets the client's own `if ( not ... )` fall through to
   * the toggle when the cursor really is empty; returning TRUE would swallow every click instead.
   */
  fn('PutItemInBackpack', () => [false]);
  fn('PutItemInBag', () => [false]);

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

  /**
   * THE MOUSE-CURSOR SHAPE SETTERS -- `ResetCursor`, `ShowInspectCursor`, `ShowContainerSellCursor`,
   * `ShowBuybackSellCursor`, `SetCursor`.
   *
   * These change the POINTER's art, not the carried item: the magnifying glass over a readable book,
   * the coin over a sellable item at a vendor, and the plain arrow everything else resets to. They are
   * a different mechanism from `PickupSpell` above.
   *
   * DECLARED, not written, and the reason is that the world pointer is owned end to end by
   * `ui/world-cursor.ts#WorldCursorDriver`, which derives its stem from what is UNDER the cursor in the
   * world (`world/cursor-mode.ts`) and re-applies it every tick -- see `STATE.md` on why the retry per
   * frame is load-bearing. A setter here would be overwritten on the very next tick, so implementing
   * one would produce a cursor that flickers rather than one that changes, and that is strictly worse
   * than being told it is missing.
   *
   * `ResetCursor` is the one that MATTERS TODAY: `ContainerFrameItemButton_OnEnter`'s last statement is
   * a four-way branch ending in `ResetCursor()` (`containerframe.lua:783-790`), so with it nil every
   * bag tooltip threw AFTER the tooltip had been built -- the handler died one line past its own
   * point. A declared stub returns, and the handler completes.
   */
  const cursorShapeGaps: Array<[string, string]> = [
    ['ResetCursor', 'the world pointer is driven per-frame by WorldCursorDriver from what is under the '
      + 'cursor, so a shape set here would be overwritten on the next tick'],
    ['ShowInspectCursor', 'as ResetCursor -- WorldCursorDriver owns the pointer shape'],
    ['ShowContainerSellCursor', 'as ResetCursor, and no merchant window exists to sell into'],
    ['ShowBuybackSellCursor', 'as ShowContainerSellCursor'],
    ['SetCursor', 'as ResetCursor -- WorldCursorDriver owns the pointer shape'],
  ];
  for (const [name, reason] of cursorShapeGaps) {
    const shapeStub = notImplemented(name, reason, []);
    fn(name, () => shapeStub(null as never, 0, []));
  }
}
