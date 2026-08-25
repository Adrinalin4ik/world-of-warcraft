import { LuaVM } from '../vm';
import { installAddOnsApi, markAddOnLoaded } from '../api/addons';

/**
 * `LoadAddOn` ANSWERS THE CONTRACT ITS ONLY CALLER READS, AND A REFUSAL IS A STRING.
 *
 * This is the surface `UIParentLoadAddOn` calls (`uiparent.lua:234-243`):
 *
 *     local loaded, reason = LoadAddOn(name);
 *     if ( not loaded ) then message(format(ADDON_LOAD_FAILED, name, _G["ADDON_"..reason])); end
 *
 * so the second return has to be a STRING whose `ADDON_`-prefixed global exists, or the concatenation
 * raises and takes `ClassTrainerFrame_LoadUI`'s whole handler with it. That, and the true/nil success
 * shape, are the whole of what the client depends on -- and they are asserted from Lua rather than from
 * TypeScript so the test exercises the same multiple-return path the client does.
 *
 * **Written because round 36 (trainers) fixed a silent lie one layer below this**: `world-runtime.ts#runAddOn`
 * answered `true` whenever an addon's `.toc` had been fetched, even when none of the files it named
 * could be resolved -- which is the reported-and-unchased shape "returns true and the addon does not
 * load". It now answers false in that case, and false HAS to arrive here as a usable reason string,
 * which is what the second case pins.
 */
describe('the addon loading API', () => {
  it('answers true/nil on a load, false/MISSING on a refusal, and does not reload', () => {
    const vm = new LuaVM();
    const asked: string[] = [];
    // The loader stands in for `runAddOn`: it loads exactly one addon and refuses everything else,
    // which is the two answers the real one can give.
    installAddOnsApi(vm, (name: string): boolean => {
      asked.push(name);
      if (name !== 'Blizzard_TrainerUI') {
        return false;
      }
      markAddOnLoaded(vm, name);
      return true;
    });

    // THE SUCCESS. `nil` and not '' for the reason -- `_G["ADDON_"..nil]` is never reached because the
    // caller's `if ( not loaded )` guard is false.
    expect(vm.runExpr(
      'local ok, why = LoadAddOn("Blizzard_TrainerUI") return tostring(ok)..","..tostring(why)',
      'addons-api.test.lua',
    )).toEqual({ value: 'true,nil' });

    // AND THE ADDON IS NOW LOADED, which is what `ClassTrainerFrame_LoadUI`'s guard reads.
    expect(vm.runExpr('return IsAddOnLoaded("Blizzard_TrainerUI")', 'a.lua')).toEqual({ value: 1 });
    // Case-insensitively -- the manifest spells these inconsistently.
    expect(vm.runExpr('return IsAddOnLoaded("blizzard_trainerui")', 'b.lua')).toEqual({ value: 1 });

    // A SECOND CALL MUST NOT RE-RUN THE FILES. This is what stops `GMChatFrame_LoadUI` rebuilding a
    // frame tree on every whisper, and it is visible here as the loader not being asked again.
    expect(vm.runExpr('return tostring(LoadAddOn("Blizzard_TrainerUI"))', 'c.lua')).toEqual({ value: 'true' });
    expect(asked).toEqual(['Blizzard_TrainerUI']);

    // THE REFUSAL. The reason must be a STRING the caller can concatenate; `MISSING` is one of the 21
    // `ADDON_*` strings `GlobalStrings.lua` ships, so `ADDON_MISSING` resolves.
    expect(vm.runExpr(
      'local ok, why = LoadAddOn("Blizzard_Nonesuch") return tostring(ok)..","..type(why)..","..why',
      'd.lua',
    )).toEqual({ value: 'false,string,MISSING' });
    // A refused addon is NOT recorded as loaded, and the negative is nil rather than 0 -- `0` is truthy
    // in Lua, so a 0 here would make every `if ( IsAddOnLoaded(...) )` guard in the manifest skip a
    // load that never happened.
    expect(vm.runExpr('return tostring(IsAddOnLoaded("Blizzard_Nonesuch"))', 'e.lua')).toEqual({ value: 'nil' });

    vm.dispose();
  });
});
