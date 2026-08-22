/**
 * `GetQuestGreenRange()` -- one nil global that broke the WHOLE quest log.
 *
 * MEASURED, the owner's console on opening the log:
 *
 *     QuestLogFrame: OnShow: [string "UIParent.lua"]:3367:
 *     attempt to call a nil value (global 'GetQuestGreenRange')
 *
 * `:3367` sits inside the client's own `GetQuestDifficultyColor`, which `QuestLog_Update` calls to
 * colour each row. The raise landed mid-loop on the selected row, and `QuestLog_OnShow` calls
 * `QuestLogDetailFrame_AttachToQuestLog()` LAST (`questlogframe.lua:284-296`) -- so the phantom rows,
 * the dead `HybridScrollFrame_Update` and the blank right page were all the same nil.
 *
 * The value is the reference's byte-verified grey band (`benilla-ui/src/script/unit/mod.rs:214-231`,
 * `GREY_BAND[playerLevel / 5]`), and 30 is the level its own test pins: entry 6 is 7.
 */
import { LuaVM } from '../lua/vm';
import { emptySnapshot, installUnitsApi, setUnit } from '../lua/api/units';

describe('GetQuestGreenRange', () => {
  it('answers the grey band for the player level', () => {
    const vm = new LuaVM();
    installUnitsApi(vm);

    const player = emptySnapshot();
    player.level = 30;
    setUnit(vm, 'player', player);

    expect(vm.run('band = GetQuestGreenRange()', 'band')).toBeNull();
    expect(vm.getGlobal('band')).toBe(7);
  });
});
