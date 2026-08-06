import { LuaVM } from '../vm';
import { FrameRegistry, installObjectModel } from '../object';
import { fireEvent } from '../events';

describe('events', () => {
  it('fires OnEvent in registration order, and still visits a frame registered mid-dispatch', () => {
    const vm = new LuaVM();
    const registry = new FrameRegistry();
    installObjectModel(vm, registry);

    const error = vm.run(
      `
      callCount = 0

      first = CreateFrame("Frame", "First")
      second = CreateFrame("Frame", "Second")
      third = CreateFrame("Frame", "Third")

      first:RegisterEvent("PLAYER_LOGIN")
      second:RegisterEvent("PLAYER_LOGIN")

      first:SetScript("OnEvent", function(self, event, ...)
        callCount = callCount + 1
        firstOrder = callCount
        -- Registered from inside the first handler's own dispatch: rule 2 says this must still be
        -- visited by THIS fire, not just the next one.
        third:RegisterEvent("PLAYER_LOGIN")
      end)

      second:SetScript("OnEvent", function(self, event, ...)
        callCount = callCount + 1
        secondOrder = callCount
      end)

      third:SetScript("OnEvent", function(self, event, ...)
        callCount = callCount + 1
        thirdOrder = callCount
      end)
      `,
      'events.test.lua',
    );
    expect(error).toBeNull();

    fireEvent(vm, 'PLAYER_LOGIN');

    expect(vm.getGlobal('firstOrder')).toBe(1);
    expect(vm.getGlobal('secondOrder')).toBe(2);
    expect(vm.getGlobal('thirdOrder')).toBe(3);

    vm.dispose();
  });
});
