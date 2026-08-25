import { LuaVM } from '../vm';
import {
  cancelCursor, dropCursorOnWorld, getCursor, getCursorItem, installCursorApi, setCursorHandlers,
  setCursorItem,
} from '../api/cursor';

/**
 * THE TWO WAYS A CARRIED ABILITY IS PUT DOWN, which are the difference between the owner's two reports:
 * "I cannot drop the spell to the empty place to discard action", and "after that I can no longer let go
 * of the captured skill".
 *
 * Neither has any Lua to run -- `WorldFrame` declares no `OnReceiveDrag` (`worldframe.xml:23-77`) and no
 * file in the manifest touches the cursor on Escape -- so both are engine doors and this is the contract
 * they have to keep: a drop on the world DELETES the source slot, and Escape does not.
 */
function vmWithCursor() {
  const vm = new LuaVM();
  installCursorApi(vm);
  const discarded: number[] = [];
  setCursorHandlers(vm, {
    place: () => true,
    pick: (action) => ({
      kind: 'action', spellId: 331, bookSlot: 2, sourceSlot: action, texture: null,
    }),
    pickSpell: () => null,
    discard: (slot) => { discarded.push(slot); },
  });
  return { vm, discarded };
}

describe('the cursor', () => {
  it('deletes the source slot when the drop lands on the world, and clears', () => {
    const { vm, discarded } = vmWithCursor();

    vm.run('PickupAction(4)', 'test');
    expect(getCursor(vm)).not.toBeNull();

    expect(dropCursorOnWorld(vm)).toBe(true);
    expect(discarded).toEqual([4]);
    expect(getCursor(vm)).toBeNull();
  });

  it('puts the cursor down on Escape WITHOUT deleting anything', () => {
    const { vm, discarded } = vmWithCursor();

    vm.run('PickupAction(4)', 'test');
    expect(cancelCursor(vm)).toBe(true);
    expect(getCursor(vm)).toBeNull();
    expect(discarded).toEqual([]);
    // ... and an empty cursor answers false, which is what keeps Escape reaching TOGGLEGAMEMENU.
    expect(cancelCursor(vm)).toBe(false);
  });

  /**
   * THE ITEM ARM, through the two globals the client's own Lua tests right after a pickup:
   * `ContainerFrameItemButton_OnClick` does `PickupContainerItem(...); if ( CursorHasItem() ) then`
   * (`containerframe.lua:715-717`) and `GetCursorInfo`'s first return is what every other branch in that
   * handler keys on. The TRANSITIONS live in `ui/container-bridge.ts` (they need the world); what this
   * covers is that the shared payload space reports an item as an item and a spell as a spell.
   */
  it('reports an item on the cursor as "item", not as a spell, and Escape puts it back', () => {
    const { vm, discarded } = vmWithCursor();

    setCursorItem(vm, {
      kind: 'item',
      spellId: 0,
      bookSlot: null,
      sourceSlot: null,
      texture: 'Interface\\Icons\\INV_Sword_06',
      item: {
        bag: 0,
        slot: 3,
        itemId: 25,
        link: '|Hitem:25|h[Worn Shortsword]|h',
        // Captured at pickup for `DELETE_ITEM_CONFIRM` -- see `CursorItemSource`.
        name: 'Worn Shortsword',
        quality: 1,
        equipSlots: [16, 17],
      },
    });

    // `runExpr` answers `LuaError | { value }`; a raise in one of these would be the failure itself, so
    // the read is narrowed rather than asserted around.
    const value = (src: string): unknown => {
      const answer = vm.runExpr(src, 't') as { value?: unknown };
      return answer.value;
    };
    expect(value('return CursorHasItem()')).toBe(true);
    expect(value('return CursorHasSpell()')).toBe(false);
    expect(value('local t, id = GetCursorInfo() return t .. "/" .. id')).toBe('item/25');
    expect(getCursorItem(vm)?.equipSlots).toEqual([16, 17]);

    // A WORLD DROP ASKS FIRST AND KEEPS THE ITEM, which is the contract the client's own dialogue is
    // written against: `DELETE_ITEM`'s `OnUpdate` hides itself the moment `CursorHasItem()` goes false
    // (`staticpopup.lua:1582-1586`), so clearing the cursor here would dismiss the very prompt it
    // raised. Only the dialogue's `OnAccept` -> `DeleteCursorItem` destroys anything, and `discarded`
    // staying empty is the proof that nothing was destroyed on the way past.
    expect(dropCursorOnWorld(vm)).toBe(true);
    expect(getCursorItem(vm)).not.toBeNull();
    expect(discarded).toEqual([]);
    // ...and Escape still puts it down without destroying it.
    expect(cancelCursor(vm)).toBe(true);
    expect(getCursorItem(vm)).toBeNull();
  });
});
