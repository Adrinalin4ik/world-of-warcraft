import { LuaVM } from '../vm';
import { FrameRegistry, installObjectModel } from '../object';
import { invokeScriptHandler } from '../scripts';

describe('SetScript and the calling convention', () => {
  it('a handler sees both `this` and `self`, and both `arg1` and `...`', () => {
    const vm = new LuaVM();
    const registry = new FrameRegistry();
    const ctx = installObjectModel(vm, registry);

    const error = vm.run(
      `
      frame = CreateFrame("Frame", "Watched")
      frame:SetScript("OnClick", function(self, ...)
        sawThisEqualsSelf = (this == self)
        sawArg1EqualsSelectOne = (arg1 == select(1, ...))
        capturedEvent = event
        capturedArg2 = arg2
      end)
      `,
      'scripts-dual.test.lua',
    );
    expect(error).toBeNull();

    const id = registry.byName('Watched')!;
    const invokeError = invokeScriptHandler(ctx, id, 'OnClick', ['LeftButton', 'extra']);
    expect(invokeError).toBeNull();

    // Both idioms, in the same call: the modern positional read and the legacy globals must agree.
    expect(vm.getGlobal('sawThisEqualsSelf')).toBe(true);
    expect(vm.getGlobal('sawArg1EqualsSelectOne')).toBe(true);
    expect(vm.getGlobal('capturedEvent')).toBe('LeftButton');
    expect(vm.getGlobal('capturedArg2')).toBe('extra');

    vm.dispose();
  });

  it('restores the outer handler\'s globals after a nested fire, even though the inner call overwrites them', () => {
    const vm = new LuaVM();
    const registry = new FrameRegistry();
    const ctx = installObjectModel(vm, registry);

    const error = vm.run(
      `
      outer = CreateFrame("Frame", "Outer")
      inner = CreateFrame("Frame", "Inner")

      inner:SetScript("OnClick", function() end)

      outer:SetScript("OnClick", function(self, ...)
        beforeThis = (this == outer)
        beforeEvent = event
        beforeArg1 = arg1
        __fireInner()
        afterThis = (this == outer)
        afterEvent = event
        afterArg1 = arg1
      end)
      `,
      'scripts-nested.test.lua',
    );
    expect(error).toBeNull();

    const outerId = registry.byName('Outer')!;
    const innerId = registry.byName('Inner')!;

    vm.registerFunction('__fireInner', () => {
      const nestedError = invokeScriptHandler(ctx, innerId, 'OnClick', ['NestedButton']);
      expect(nestedError).toBeNull();
      return [];
    });

    const outerError = invokeScriptHandler(ctx, outerId, 'OnClick', ['OuterButton']);
    expect(outerError).toBeNull();

    // If the nested `inner` fire's globals leaked out, `afterThis`/`afterEvent`/`afterArg1` would read
    // back as `inner`/'NestedButton' instead of `outer`'s own values.
    expect(vm.getGlobal('beforeThis')).toBe(true);
    expect(vm.getGlobal('afterThis')).toBe(true);
    expect(vm.getGlobal('beforeEvent')).toBe('OuterButton');
    expect(vm.getGlobal('afterEvent')).toBe('OuterButton');
    expect(vm.getGlobal('beforeArg1')).toBe('OuterButton');
    expect(vm.getGlobal('afterArg1')).toBe('OuterButton');

    vm.dispose();
  });
});
