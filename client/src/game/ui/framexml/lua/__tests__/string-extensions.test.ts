import { LuaVM } from '../vm';
import { installCompat } from '../compat';

/**
 * `strsplit`, guarded on the property whose absence is SILENT rather than on the one that throws.
 *
 * A missing `strsplit` raises and says so -- that is how this was found, from `ItemRef.lua:12` on a
 * click on a player's name in chat. What would NOT say so is dropping empty fields: that call is
 *
 *     local name, lineid, chatType, chatTarget = strsplit(":", namelink);
 *
 * over a `player:Name:lineID:chatType:chatTarget` link whose middle fields are frequently empty. An
 * implementation that skipped them would slide `chatType` into `lineid` and hand
 * `FriendsFrame_ShowDropdown` the wrong arguments, with nothing raising anywhere.
 *
 * So the assertion is the SHAPE of a link with a hole in it, not that a simple string splits.
 */
describe("WoW's string extensions", () => {
  it('keeps empty fields, so a link with holes destructures into the right names', () => {
    const vm = new LuaVM();
    installCompat(vm);

    const error = vm.run(
      `local name, lineid, chatType, target = strsplit(":", "Gdsh::PARTY:")
       one, two, three, four = name, lineid, chatType, target
       count = select("#", strsplit(":", "a::b"))
       joined = strjoin("-", "a", "b", "c")
       trimmed = "[" .. strtrim("  padded\\t") .. "]"`,
      'strsplit-test',
    );

    expect(error).toBeNull();
    // The name, an EMPTY line id, the chat type in its own slot, and an empty trailing field.
    expect(vm.getGlobal('one')).toBe('Gdsh');
    expect(vm.getGlobal('two')).toBe('');
    expect(vm.getGlobal('three')).toBe('PARTY');
    expect(vm.getGlobal('four')).toBe('');
    // Three values from two delimiters, which is what "empty fields are kept" means.
    expect(vm.getGlobal('count')).toBe(3);
    expect(vm.getGlobal('joined')).toBe('a-b-c');
    expect(vm.getGlobal('trimmed')).toBe('[padded]');
  });
});
