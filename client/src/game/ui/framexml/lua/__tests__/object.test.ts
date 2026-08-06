import { LuaVM } from '../vm';
import { FrameRegistry, installObjectModel, registerMethods } from '../object';

// The method tables below are FAKE -- tasks 3 and 4 register the real ones through this same
// `registerMethods` entry point. What is under test is the dispatch mechanism, not any method: a
// tag per class is the cheapest way to see exactly which tables a given widget's lookups walk.
registerMethods('REGION', { GetRegionTag: () => ['region'] });
registerMethods('FRAME', { GetFrameTag: () => ['frame'] });
registerMethods('BUTTON', { GetButtonTag: () => ['button'] });
registerMethods('CHECKBUTTON', { GetCheckTag: () => ['check'] });
// One method that goes through the context, so the id->Widget and id->wrapper directions are
// exercised too rather than only the name resolution.
registerMethods('REGION', {
  GetParentFrame: (ctx, self) => {
    const parent = ctx.registry.parentOf(self);
    return [parent === null ? null : ctx.wrapper(parent)];
  },
});

describe('the FrameScript object model', () => {
  it('resolves methods along the class chain, answers nil off it, and publishes names to _G', () => {
    const vm = new LuaVM();
    const registry = new FrameRegistry();
    installObjectModel(vm, registry);

    const error = vm.run(
      `
      local frame = CreateFrame("Frame", "MyFrame")
      local check = CreateFrame("CheckButton", "MyCheck", frame)

      -- The class chain: CheckButton -> Button -> Frame -> Region.
      chain = check:GetCheckTag() .. "," .. check:GetButtonTag() .. "," ..
              check:GetFrameTag() .. "," .. check:GetRegionTag()

      -- Duck typing, the whole reason the tables are per kind: a plain Frame is not a Button.
      plainFrameHasButtonMethod = frame.GetButtonTag ~= nil
      checkHasButtonMethod = check.GetButtonTag ~= nil

      -- Identity: the wrapper handed back for an id must be the SAME table every time.
      parentIsSameTable = (check:GetParentFrame() == frame)
      globalIsSameTable = (MyCheck == check)

      -- First frame with a name owns the global; a later namesake does not take it.
      local impostor = CreateFrame("Frame", "MyFrame")
      globalSurvivedNamesake = (MyFrame == frame) and (impostor ~= frame)

      -- An unknown frame type is a hard Lua error, which means pcall can see it.
      unknownKindErrored = not (pcall(CreateFrame, "Sparkle"))
      `,
      'object.test.lua',
    );

    expect(error).toBeNull();
    expect(vm.getGlobal('chain')).toBe('check,button,frame,region');
    expect(vm.getGlobal('plainFrameHasButtonMethod')).toBe(false);
    expect(vm.getGlobal('checkHasButtonMethod')).toBe(true);
    expect(vm.getGlobal('parentIsSameTable')).toBe(true);
    expect(vm.getGlobal('globalIsSameTable')).toBe(true);
    expect(vm.getGlobal('globalSurvivedNamesake')).toBe(true);
    expect(vm.getGlobal('unknownKindErrored')).toBe(true);

    // The JS side of the same two frames: the widget tree really was built, and the child frame is
    // one level above its parent (`Widget#add`'s rule, not re-applied here).
    const frameId = registry.byName('MyFrame')!;
    const checkId = registry.byName('MyCheck')!;
    expect(registry.widget(frameId)!.kind).toBe('frame');
    expect(registry.widget(checkId)!.kind).toBe('checkbutton');
    expect(registry.widget(checkId)!.frameLevel).toBe(registry.widget(frameId)!.frameLevel + 1);

    // A screen teardown releases every wrapper handle and gives up the names it owns.
    registry.reset();
    expect(registry.byName('MyFrame')).toBeNull();
    expect(vm.getGlobal('MyFrame')).toBeUndefined();

    vm.dispose();
  });
});
