/**
 * `GameTooltip:SetUnit(unit)`.
 *
 * Owner: "При наведении на юнита должен появляться тултип." This is the engine method behind both the
 * world hover and a unit frame's hover (`unitframe.lua:144-154`), and it was a declared gap whose note
 * said it needed a hover feed the world pass did not raise -- the pick has raised one since.
 *
 * Two tests: the player line, whose format string is the client's own `PLAYER_LEVEL`; and a creature,
 * where the second substitution is a forced choice because this client has no creature type.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';
import { emptySnapshot, setUnit } from '../lua/api/units';

/** A `GameTooltip` with the line slots its real template authors. */
const DOC = `
  <Ui>
    <GameTooltip name="GameTooltip">
      <Size><AbsDimension x="200" y="60"/></Size>
      <Layers><Layer level="ARTWORK">
        <FontString name="$parentTextLeft1"/>
        <FontString name="$parentTextRight1"/>
        <FontString name="$parentTextLeft2"/>
        <FontString name="$parentTextRight2"/>
        <FontString name="$parentTextLeft3"/>
        <FontString name="$parentTextRight3"/>
      </Layer></Layers>
      <Frames>
        <StatusBar name="$parentStatusBar" hidden="true">
          <Size><AbsDimension x="0" y="8"/></Size>
        </StatusBar>
      </Frames>
    </GameTooltip>
  </Ui>
`;

function boot() {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry, null);
  const rt = createFrameXmlRuntime(vm, ctx);
  const report = loadDocument(rt, parseXml(DOC), () => null, 'inline.xml');
  expect(report.errors).toEqual([]);
  // The client's own format strings, as `GlobalStrings.lua` defines them.
  vm.run(`
    PLAYER_LEVEL = "Level %s %s %s";
    UNIT_TYPE_LEVEL_TEMPLATE = "Level %d %s";
    UNIT_TYPE_PLUS_LEVEL_TEMPLATE = "Level %d Elite %s";
    UNIT_LEVEL_TEMPLATE = "Level %d";
  `, 'strings');
  return { vm };
}

describe('GameTooltip:SetUnit', () => {
  it('names a player and levels him with the client PLAYER_LEVEL string', () => {
    const { vm } = boot();
    const snapshot = emptySnapshot();
    snapshot.name = 'Gesf';
    snapshot.level = 4;
    snapshot.isPlayer = true;
    snapshot.race = { name: 'Human', token: 'Human' };
    snapshot.classInfo = { name: 'Warrior', token: 'WARRIOR' };
    setUnit(vm, 'mouseover', snapshot);

    expect(vm.run('filled = GameTooltip:SetUnit("mouseover")', 't')).toBeNull();
    expect(vm.getGlobal('filled')).toBe(true);
    expect(vm.run('l1 = GameTooltipTextLeft1:GetText(); l2 = GameTooltipTextLeft2:GetText()', 't'))
      .toBeNull();
    expect(vm.getGlobal('l1')).toBe('Gesf');
    expect(vm.getGlobal('l2')).toBe('Level 4 Human Warrior');
  });

  it('falls back to UNIT_LEVEL_TEMPLATE for a creature, and answers false for an empty token', () => {
    const { vm } = boot();
    const wolf = emptySnapshot();
    wolf.name = 'Diseased Timber Wolf';
    wolf.level = 12;
    wolf.isPlayer = false;
    // The word `CreatureType.dbc` gives id 1 -- the owner's "Животное" beside our missing line.
    wolf.creatureType = 'Beast';
    setUnit(vm, 'mouseover', wolf);

    expect(vm.run('GameTooltip:SetUnit("mouseover")', 't')).toBeNull();
    expect(vm.run('l1 = GameTooltipTextLeft1:GetText(); l2 = GameTooltipTextLeft2:GetText()', 't'))
      .toBeNull();
    expect(vm.getGlobal('l1')).toBe('Diseased Timber Wolf');
    // `UNIT_TYPE_LEVEL_TEMPLATE`, with the type the packet carried all along.
    expect(vm.getGlobal('l2')).toBe('Level 12 Beast');

    // An elite takes the client's OWN other string, `UNIT_TYPE_PLUS_LEVEL_TEMPLATE`, so the wording is
    // authored and not ours.
    const elite = emptySnapshot();
    elite.name = 'Ravager';
    elite.level = 12;
    elite.creatureType = 'Beast';
    elite.classification = 'elite';
    setUnit(vm, 'mouseover', elite);
    expect(vm.run('GameTooltip:SetUnit("mouseover")', 't')).toBeNull();
    expect(vm.run('l2 = GameTooltipTextLeft2:GetText()', 't')).toBeNull();
    expect(vm.getGlobal('l2')).toBe('Level 12 Elite Beast');

    // `IsUnit` is what lets the client's own <OnTooltipSetUnit> colour line 1.
    expect(vm.run('same = GameTooltip:IsUnit("MOUSEOVER"); other = GameTooltip:IsUnit("target")', 't'))
      .toBeNull();
    expect(vm.getGlobal('same')).toBe(true);
    expect(vm.getGlobal('other')).toBe(false);

    // A token nothing occupies must answer false -- that is what clears `self.UpdateTooltip`.
    expect(vm.run('empty = GameTooltip:SetUnit("target")', 't')).toBeNull();
    expect(vm.getGlobal('empty')).toBe(false);
  });

  /**
   * THE BAR IS PART OF `SetOwner`'S RESET, and its absence put a health strip on every tooltip.
   *
   * The owner's screenshot was the XP Bar tooltip -- plain text, no unit -- carrying the green strip.
   * Every tooltip path enters through `SetOwner` (`GameTooltip_SetDefaultAnchor`'s first line,
   * `gametooltip.lua:72-76`), so that is where the previous tooltip's unit state has to go.
   */
  it('hides the health bar and forgets the unit when the tooltip is re-owned', () => {
    const { vm } = boot();
    const snapshot = emptySnapshot();
    snapshot.name = 'Gesf';
    snapshot.level = 4;
    snapshot.health = 60;
    snapshot.maxHealth = 100;
    setUnit(vm, 'mouseover', snapshot);

    expect(vm.run('GameTooltip:SetUnit("mouseover")', 't')).toBeNull();
    expect(vm.run('shown = GameTooltipStatusBar:IsShown(); isU = GameTooltip:IsUnit("mouseover")', 't'))
      .toBeNull();
    expect(vm.getGlobal('shown')).toBe(true);
    expect(vm.getGlobal('isU')).toBe(true);

    // The next tooltip is a plain one: `GameTooltip_AddNewbieTip` reaches `SetOwner` for the XP bar.
    expect(vm.run('GameTooltip:SetOwner(UIParent, "ANCHOR_NONE"); GameTooltip:SetText("XP Bar")', 't'))
      .toBeNull();
    expect(vm.run('shown = GameTooltipStatusBar:IsShown(); isU = GameTooltip:IsUnit("mouseover")', 't'))
      .toBeNull();
    expect(vm.getGlobal('shown')).toBe(false);
    expect(vm.getGlobal('isU')).toBe(false);
  });
});
