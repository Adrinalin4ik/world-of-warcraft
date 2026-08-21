import { LuaVM } from '../vm';
import { FrameRegistry, installObjectModel } from '../object';
import { compileScriptHandler, invokeScriptHandler, setScriptHandler } from '../scripts';

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
  it("compiles an <OnEvent> body with the engine's own parameter list, so `...` is the event's ARGS", () => {
    const vm = new LuaVM();
    const registry = new FrameRegistry();
    const ctx = installObjectModel(vm, registry);

    // The shape real FrameXML is written in, verbatim from gluedialog.xml:167 -- a body that forwards
    // `event` and `...` to a global. Compiled as `function(self, ...)` it saw the event NAME as its
    // first vararg, so `GlueDialog_OnEvent` got `arg1 = "OPEN_STATUS_DIALOG"` and the dialog type was
    // nil. `fireEvent` passes `[eventName, ...args]`, so the `event` parameter is what absorbs it.
    const error = vm.run(
      `
      seen = {}
      function Handler(self, event, ...)
        seen.event = event
        seen.first = select(1, ...)
        seen.count = select("#", ...)
      end
      `,
      'scripts-onevent.test.lua',
    );
    expect(error).toBeNull();

    const compiled = compileScriptHandler(
      vm,
      'OnEvent',
      'Handler(self, event, ...);',
      null,
      'inline.xml',
    );
    expect(compiled).not.toBeNull();
    const id = registry.create('Frame', 'Dialog', null);
    setScriptHandler(vm, id, 'OnEvent', compiled!);

    expect(invokeScriptHandler(ctx, id, 'OnEvent', ['OPEN_STATUS_DIALOG', 'CANCEL', 'Connecting'])).toBeNull();

    expect(vm.run('e, f, n = seen.event, seen.first, seen.count', 'read.lua')).toBeNull();
    expect(vm.getGlobal('e')).toBe('OPEN_STATUS_DIALOG');
    expect(vm.getGlobal('f')).toBe('CANCEL');
    expect(vm.getGlobal('n')).toBe(2);

    vm.dispose();
  });

  /**
   * A SECOND runtime's frame 1 must not reach the first runtime's handle.
   *
   * The world UI host mounts twice with one copy disposed, frame ids restart at 1 per `FrameRegistry`,
   * and a `LuaRef` indexes ONE VM's handle table. With the store keyed by frame id alone, this second
   * `setScriptHandler` found the first VM's handle at the same key and released it -- `vm2.unref` against
   * `vm1`'s index -- which freed whatever slot the new VM held there, usually the handler this very call
   * was about to store. A freed slot holds the free-list sentinel, so the dispatch reached a TABLE:
   * "attempt to call a table value", with the handler registered and `GetScript` answering non-nil.
   */
  it('a handler on a second VM with the same frame id still dispatches', () => {
    const first = new LuaVM();
    const firstRegistry = new FrameRegistry();
    installObjectModel(first, firstRegistry);
    const firstId = firstRegistry.create('Frame', 'Detail', null);
    const firstHandler = compileScriptHandler(first, 'OnEvent', 'ran = 1;', null, 'first.xml');
    expect(firstHandler).not.toBeNull();
    setScriptHandler(first, firstId, 'OnEvent', firstHandler!);

    // The remount: a fresh VM and registry, so the same id and very likely the same handle index.
    const second = new LuaVM();
    const secondRegistry = new FrameRegistry();
    const secondCtx = installObjectModel(second, secondRegistry);
    const secondId = secondRegistry.create('Frame', 'Detail', null);
    expect(secondId).toBe(firstId);
    const secondHandler = compileScriptHandler(second, 'OnEvent', 'ran = 2;', null, 'second.xml');
    expect(secondHandler).not.toBeNull();
    setScriptHandler(second, secondId, 'OnEvent', secondHandler!);

    expect(invokeScriptHandler(secondCtx, secondId, 'OnEvent', [])).toBeNull();
    expect(second.getGlobal('ran')).toBe(2);

    second.dispose();
    first.dispose();
  });
});
