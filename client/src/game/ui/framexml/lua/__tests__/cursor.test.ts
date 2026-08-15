import { LuaVM } from '../vm';
import {
  cancelCursor, dropCursorOnWorld, getCursor, installCursorApi, setCursorHandlers,
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
});
