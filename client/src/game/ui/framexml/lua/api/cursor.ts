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
}

const stateByVm = new WeakMap<LuaVM, CursorState>();

function stateOf(vm: LuaVM): CursorState {
  let state = stateByVm.get(vm);
  if (state === undefined) {
    state = { held: null, place: null, pick: null, pickSpell: null };
    stateByVm.set(vm, state);
  }
  return state;
}

/** What the cursor is carrying, for the host's own draw pass. Null when empty. */
export function getCursor(vm: LuaVM): CursorPayload | null {
  return stateOf(vm).held;
}

/** The host's three doors. See `CursorState` for why `place` answers a boolean. */
export function setCursorHandlers(vm: LuaVM, handlers: {
  place: (destination: number, payload: CursorPayload) => boolean;
  pick: (action: number) => CursorPayload | null;
  pickSpell: (slot: number) => CursorPayload | null;
}): void {
  const state = stateOf(vm);
  state.place = handlers.place;
  state.pick = handlers.pick;
  state.pickSpell = handlers.pickSpell;
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
   * `ClearCursor()` -- stop carrying.
   *
   * In the real client, clearing a cursor that holds an action DELETES that action from its slot (which
   * is what dropping an ability on the world does). That half is deliberately absent -- see
   * `PickupAction` -- so this only forgets the payload. The consequence is stated rather than hidden: an
   * ability cannot be REMOVED from the bar by dragging it off, only moved or overwritten.
   */
  fn('ClearCursor', () => {
    state.held = null;
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
