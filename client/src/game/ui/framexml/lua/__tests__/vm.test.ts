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

  it('returns a syntax error rather than throwing', () => {
    const vm = new LuaVM();
    const error = vm.run('this is not lua', 'bad.lua');

    expect(error).not.toBeNull();
    expect(error!.chunk).toBe('bad.lua');
  });
});
