import { LuaVM } from '../vm';
import { SpellbookSnapshot, installSpellsApi, setSpellbook } from '../api/spells';

/**
 * `GetSpellTabInfo` returns SIX values and `GetKnownSlotFromHighestRankSlot` maps between the book's two
 * parallel indexings -- the one thing in this API that a plausible-looking four-return version breaks.
 *
 * Why this and not the tab GROUPING: the grouping is a DBC join and is verified by measurement against the
 * served files (`pipeline/dbc/skill-data.ts` records the columns and the whole category partition). What a
 * unit test can catch that a measurement cannot is the CONTRACT with the client's own Lua, which is where
 * this area's sharp edge is: with `ShowAllSpellRanks` off -- the default -- `SpellBook_GetTabInfo`
 * substitutes returns 5 and 6 for 3 and 4 (`spellbookframe.lua:656-663`) and then
 * `SpellBook_GetSpellID` feeds the result through `GetKnownSlotFromHighestRankSlot` (`:596-598`). A book
 * that got either half wrong would still draw twelve buttons, which is exactly the failure mode that needs
 * a test rather than a screenshot.
 *
 * The snapshot below is the shape the shaman test character actually produces, shrunk: a General tab with
 * one rankless spell, then a class tab holding a three-rank family and a single-rank spell -- so the
 * high-rank list is shorter than the full list and the mapping is not the identity.
 */
function book(): SpellbookSnapshot {
  const entry = (spellId: number, name: string, subName: string) => ({
    spellId,
    name,
    subName,
    description: '',
    texture: `Interface\\Icons\\Icon_${spellId}`,
    passive: false,
    cooldownStart: 0,
    cooldownDuration: 0,
  });

  return {
    tabs: [
      // General: `Auto Attack`, one entry, no ranks.
      {
        name: 'General',
        texture: 'Interface\\Icons\\INV_Misc_QuestionMark',
        offset: 0,
        numSpells: 1,
        highestRankOffset: 0,
        highestRankNumSpells: 1,
      },
      // Elemental Combat: Lightning Bolt ranks 1-3, then Rockbiter. 4 spells, 2 top ranks.
      {
        name: 'Elemental Combat',
        texture: 'Interface\\Icons\\Spell_Nature_Lightning',
        offset: 1,
        numSpells: 4,
        highestRankOffset: 1,
        highestRankNumSpells: 2,
      },
    ],
    all: [
      entry(6603, 'Auto Attack', ''),
      entry(403, 'Lightning Bolt', 'Rank 1'),
      entry(529, 'Lightning Bolt', 'Rank 2'),
      entry(548, 'Lightning Bolt', 'Rank 3'),
      entry(8017, 'Rockbiter Weapon', 'Rank 1'),
    ],
    high: [
      entry(6603, 'Auto Attack', ''),
      entry(548, 'Lightning Bolt', 'Rank 3'),
      entry(8017, 'Rockbiter Weapon', 'Rank 1'),
    ],
    // 1-based on both sides: high slot 1 -> all slot 1, high 2 -> all 4 (Lightning Bolt rank 3),
    // high 3 -> all 5 (Rockbiter).
    knownSlotOfHigh: [1, 4, 5],
  };
}

describe('the spellbook API', () => {
  it('answers GetSpellTabInfo with six values and maps a high-rank slot to its known slot', () => {
    const vm = new LuaVM();
    installSpellsApi(vm);
    setSpellbook(vm, book());

    expect((vm.runExpr('return GetNumSpellTabs()', 'test') as { value: unknown }).value).toBe(2);

    // SIX returns, in the engine's order. Packed into a table because `runExpr` yields one value.
    const tab = vm.runExpr(
      'local n, t, o, c, ho, hc = GetSpellTabInfo(2); return n .. "|" .. t .. "|" .. o .. "|" .. c '
        + '.. "|" .. ho .. "|" .. hc',
      'test',
    ) as { value: unknown };
    expect(tab.value).toBe('Elemental Combat|Interface\\Icons\\Spell_Nature_Lightning|1|4|1|2');

    // The mapping the top-rank view depends on: high slot 2 is Lightning Bolt rank 3, which lives at
    // full-list slot 4. An identity mapping would name rank 1 here.
    expect((vm.runExpr('return GetKnownSlotFromHighestRankSlot(2)', 'test') as { value: unknown }).value)
      .toBe(4);

    // ... and reading that slot names the right spell and its rank, with the rank as a STRING never nil.
    const named = vm.runExpr(
      'local n, sub = GetSpellName(GetKnownSlotFromHighestRankSlot(2), "spell"); return n .. "/" .. sub',
      'test',
    ) as { value: unknown };
    expect(named.value).toBe('Lightning Bolt/Rank 3');

    // A rankless spell's `subSpellName` is the EMPTY STRING, which is what
    // `SpellButton_UpdateButton`'s `subSpellName ~= ""` anchor test needs (`spellbookframe.lua:510`).
    const rankless = vm.runExpr(
      'local n, sub = GetSpellName(1, "spell"); return n .. "/" .. sub .. "/" .. type(sub)',
      'test',
    ) as { value: unknown };
    expect(rankless.value).toBe('Auto Attack//string');

    // `enable` is 1 for a known spell, not 0: `spellbookframe.lua:467` greys the icon on anything else.
    const cooldown = vm.runExpr(
      'local s, d, e = GetSpellCooldown(1, "spell"); return s .. "/" .. d .. "/" .. e',
      'test',
    ) as { value: unknown };
    expect(cooldown.value).toBe('0/0/1');

    vm.dispose?.();
  });
});
