import { LuaVM } from '../vm';
import { installCompat } from '../compat';

/**
 * The `bit` library, guarded on the one property whose absence is SILENT.
 *
 * `Constants.lua:280` folds EIGHT arguments in a single `bit.bor` call, and it is the second file the
 * world manifest loads -- so `bit` being absent, or being a two-argument implementation, kills the file at
 * FILE SCOPE and loses lines 280-478 (including `QuestDifficultyColors` at 403). A two-argument version
 * would not raise; it would quietly fold only the first two operands, giving a mask that is wrong by six
 * raid targets and a client that looks fine.
 *
 * The expected value is arithmetic, not transcribed: raid targets 1-8 are `0x00100000` through
 * `0x08000000` (`constants.lua:270-277`), whose OR is `0x0FF00000` = 267386880 -- which is also what the
 * live runtime answered for `COMBATLOG_OBJECT_RAIDTARGET_MASK` after this landed.
 */
describe('the bit library', () => {
  it('folds all eight arguments of a variadic bor, as Constants.lua:280 requires', () => {
    const vm = new LuaVM();
    installCompat(vm);

    const error = vm.run(
      `mask = bit.bor(0x00100000, 0x00200000, 0x00400000, 0x00800000,
                      0x01000000, 0x02000000, 0x04000000, 0x08000000)
       anded = bit.band(0xFF00, 0x0FF0)
       notted = bit.bnot(0)
       shifted = bit.lshift(1, 31)
       sameAsLiteral = (bit.bnot(0x7FFFFFFF) == 0x80000000)`,
      'bit-test',
    );

    expect(error).toBeNull();
    expect(vm.getGlobal('mask')).toBe(0x0ff00000);
    expect(vm.getGlobal('anded')).toBe(0x0f00);
    // SIGNED 32-bit, which is BitLib's own convention and this VM's: fengari is Lua 5.3 with 32-BIT
    // integers (`math.maxinteger` is 2147483647), so a result with the top bit set is negative -- and
    // `0x80000000` written in a chunk is likewise -2147483648. An earlier draft returned unsigned values,
    // which made `bit.bnot(0x7FFFFFFF) == 0x80000000` silently FALSE. That equality is asserted below
    // precisely because it is the property the unsigned version broke without raising.
    expect(vm.getGlobal('notted')).toBe(-1);
    expect(vm.getGlobal('shifted')).toBe(-2147483648);
    expect(vm.getGlobal('sameAsLiteral')).toBe(true);
  });
});
