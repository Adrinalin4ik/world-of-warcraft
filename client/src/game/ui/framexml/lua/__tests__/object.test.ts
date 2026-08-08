import { LuaRef, LuaVM } from '../vm';
import { FrameRegistry, installObjectModel, registerMethods } from '../object';

// The method tables below are FAKE -- tasks 3 and 4 register the real ones through this same
// `registerMethods` entry point. What is under test is the dispatch mechanism, not any method: a
// tag per class is the cheapest way to see exactly which tables a given widget's lookups walk.
registerMethods('REGION', { GetRegionTag: () => ['region'] });
registerMethods('LAYEREDREGION', { GetLayeredTag: () => ['layered'] });
registerMethods('FRAME', { GetFrameTag: () => ['frame'] });
registerMethods('BUTTON', { GetButtonTag: () => ['button'] });
registerMethods('CHECKBUTTON', { GetCheckTag: () => ['check'] });

const handlers = new Map<number, LuaRef>();

registerMethods('REGION', {
  // Goes through the context in both directions: id -> Widget, and id -> the frame's Lua table.
  GetParentFrame: (ctx, self) => {
    const parent = ctx.registry.parentOf(self);
    return [parent === null ? null : ctx.wrapper(parent)];
  },
  // What `SetScript` will be: a method that KEEPS a Lua value past the end of the call. Without
  // `retain` the argument's handle is released when the call returns and its registry slot is
  // handed to the next value that crosses the boundary.
  SetHandler: (ctx, self, args) => {
    handlers.set(self, ctx.retain(args[0] as LuaRef));
    return [];
  },
  FireHandler: (ctx, self) => {
    const handler = handlers.get(self);
    if (handler === undefined) {
      throw new Error('FireHandler: nothing stored');
    }
    const error = ctx.vm.call(handler, []);
    if (error !== null) {
      throw new Error(`FireHandler: ${error.message}`);
    }
    return [];
  },
});

describe('the FrameScript object model', () => {
  it('resolves methods along the class chain, answers nil off it, and keeps what it retains', () => {
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

      -- Duck typing, the whole reason the tables are per class: a plain Frame is not a Button, and
      -- it is not a LayeredRegion either (SetVertexColor belongs to Texture and FontString).
      plainFrameHasButtonMethod = frame.GetButtonTag ~= nil
      checkHasButtonMethod = check.GetButtonTag ~= nil
      frameHasLayeredMethod = frame.GetLayeredTag ~= nil

      -- Nothing from Object.prototype leaks in as a method.
      frameHasToString = frame.toString ~= nil
      frameHasConstructor = frame.constructor ~= nil

      -- Identity: the wrapper handed back for an id must be the SAME table every time.
      parentIsSameTable = (check:GetParentFrame() == frame)
      globalIsSameTable = (MyCheck == check)

      -- A retained handler survives the churn of later calls minting and freeing handles.
      frame:SetHandler(function() handlerRan = (handlerRan or 0) + 1 end)
      local churn = CreateFrame("Frame", "Churn")
      churn:GetParentFrame()
      frame:FireHandler()

      -- Asking for a method that does not exist YET caches the negative; see below.
      lateTagBefore = frame.GetLateTag ~= nil

      -- An unknown frame type is a hard Lua error, which means pcall can see it. A type we DO know
      -- but only from the real XML -- ModelFFX is the root element of AccountLogin.xml -- is not.
      unknownKindErrored = not (pcall(CreateFrame, "Sparkle"))
      modelFFXCreated = CreateFrame("ModelFFX", "AccountLogin") ~= nil
      `,
      'object.test.lua',
    );

    expect(error).toBeNull();
    expect(vm.getGlobal('chain')).toBe('check,button,frame,region');
    expect(vm.getGlobal('plainFrameHasButtonMethod')).toBe(false);
    expect(vm.getGlobal('checkHasButtonMethod')).toBe(true);
    expect(vm.getGlobal('frameHasLayeredMethod')).toBe(false);
    expect(vm.getGlobal('frameHasToString')).toBe(false);
    expect(vm.getGlobal('frameHasConstructor')).toBe(false);
    expect(vm.getGlobal('parentIsSameTable')).toBe(true);
    expect(vm.getGlobal('globalIsSameTable')).toBe(true);
    expect(vm.getGlobal('handlerRan')).toBe(1);
    expect(vm.getGlobal('unknownKindErrored')).toBe(true);
    expect(vm.getGlobal('modelFFXCreated')).toBe(true);

    // The JS side of the same frames: the widget tree really was built, the child frame is one level
    // above its parent (`Widget#add`'s rule, not re-applied here), and a Lua class with no
    // `WidgetKind` of its own draws as a plain frame.
    const frameId = registry.byName('MyFrame')!;
    const checkId = registry.byName('MyCheck')!;
    const modelId = registry.byName('AccountLogin')!;
    expect(registry.widget(frameId)!.kind).toBe('frame');
    expect(registry.widget(checkId)!.kind).toBe('checkbutton');
    expect(registry.widget(checkId)!.frameLevel).toBe(registry.widget(frameId)!.frameLevel + 1);
    expect(registry.classOf(modelId)).toBe('MODEL');
    expect(registry.widget(modelId)!.kind).toBe('frame');

    // A method table registered AFTER a lookup has already cached the negative still takes effect:
    // registration flushes every installed VM's dispatch cache. Without that, forgetting to import
    // one of the method modules before `installObjectModel` would silently produce a UI that renders
    // and does nothing.
    expect(vm.getGlobal('lateTagBefore')).toBe(false);
    registerMethods('FRAME', { GetLateTag: () => ['late'] });
    expect(vm.run('lateTag = MyFrame:GetLateTag()', 'late.lua')).toBeNull();
    expect(vm.getGlobal('lateTag')).toBe('late');

    // A screen teardown releases every wrapper handle and gives up the names it owns.
    registry.reset();
    expect(registry.byName('MyFrame')).toBeNull();
    expect(vm.getGlobal('MyFrame')).toBeUndefined();

    vm.dispose();
  });

  it('publishes a name to _G without clobbering, and only for the frame that owns it', () => {
    const vm = new LuaVM();
    const registry = new FrameRegistry();
    installObjectModel(vm, registry);

    const error = vm.run(
      `
      -- A global that was there first is not clobbered by a frame that shares its name, and that
      -- frame is still a working frame -- it just does not own the global.
      Occupied = "a string, not a frame"
      local squatter = CreateFrame("Frame", "Occupied")
      occupiedGlobal = Occupied
      squatterStillWorks = (squatter:GetFrameTag() == "frame")

      -- Between two frames of the same name, the FIRST owns it.
      local first = CreateFrame("Frame", "Namesake")
      local second = CreateFrame("Frame", "Namesake")
      globalIsFirst = (Namesake == first)
      firstId = first.__id
      secondId = second.__id
      `,
      'object.test.lua',
    );

    expect(error).toBeNull();
    expect(vm.getGlobal('occupiedGlobal')).toBe('a string, not a frame');
    expect(vm.getGlobal('squatterStillWorks')).toBe(true);
    expect(vm.getGlobal('globalIsFirst')).toBe(true);

    // Two independent guards protect `_G` -- the registry's "the first frame owns the name" record
    // and the "do not overwrite a live global" check -- so the Lua-visible assertions above still
    // pass with either one removed. This is the one that pins the registry's own record.
    const firstId = vm.getGlobal('firstId');
    const secondId = vm.getGlobal('secondId');
    expect(secondId).not.toBe(firstId);
    expect(registry.byName('Namesake')).toBe(firstId);

    vm.dispose();
  });
});
