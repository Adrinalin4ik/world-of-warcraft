import { LuaVM } from '../vm';
import { installCompat } from '../compat';

describe('LuaVM', () => {
  it('runs a chunk, calls a registered function, and reads a global back', () => {
    const vm = new LuaVM();
    installCompat(vm);
    const seen: unknown[][] = [];
    vm.registerFunction('Record', (args) => {
      seen.push(args);
      return ['ok'];
    });

    // `unpack` is the one 5.1-ism Blizzard's own glue code uses (glueparent.lua), so the shim is
    // exercised here rather than in a test of its own.
    const error = vm.run('answer = Record("a", 2, unpack({3}))', 'test');

    expect(error).toBeNull();
    expect(seen).toEqual([['a', 2, 3]]);
    expect(vm.getGlobal('answer')).toBe('ok');
  });

  /**
   * The handle allocator, which `ref`'s docstring replaced `luaL_ref`/`luaL_unref` with to get the
   * manifest load off an O(live-handles) path. The invariant that makes the sentinel scheme safe is
   * the one pinned here: a slot is REUSED after release, and a handle held across that reuse still
   * points at its own value rather than at whatever took the slot.
   */
  it('reuses a released handle slot without disturbing a handle that is still held', () => {
    const vm = new LuaVM();
    const held = vm.newTable();
    vm.setTableField(held, 'mark', 'held');

    // Release one handle and mint another: the freed slot is the one the next `newTable` takes.
    const released = vm.newTable();
    vm.setTableField(released, 'mark', 'released');
    vm.unref(released);
    const reused = vm.newTable();
    vm.setTableField(reused, 'mark', 'reused');

    expect(vm.getTableField(reused, 'mark')).toBe('reused');
    expect(vm.getTableField(held, 'mark')).toBe('held');
  });

  it('returns a syntax error rather than throwing', () => {
    const vm = new LuaVM();
    const error = vm.run('this is not lua', 'bad.lua');

    expect(error).not.toBeNull();
    expect(error!.chunk).toBe('bad.lua');
  });
});
