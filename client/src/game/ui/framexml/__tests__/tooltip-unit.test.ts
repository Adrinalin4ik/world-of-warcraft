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
    UNIT_LEVEL_TEMPLATE = "Level %d";
    ELITE = "Elite";
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
    setUnit(vm, 'mouseover', wolf);

    expect(vm.run('GameTooltip:SetUnit("mouseover")', 't')).toBeNull();
    expect(vm.run('l1 = GameTooltipTextLeft1:GetText(); l2 = GameTooltipTextLeft2:GetText()', 't'))
      .toBeNull();
    expect(vm.getGlobal('l1')).toBe('Diseased Timber Wolf');
    // No creature TYPE exists in this client, so a normal creature takes the type-less template rather
    // than a made-up "Humanoid". An elite would read "Level 12 Elite".
    expect(vm.getGlobal('l2')).toBe('Level 12');

    // A token nothing occupies must answer false -- that is what clears `self.UpdateTooltip`.
    expect(vm.run('empty = GameTooltip:SetUnit("target")', 't')).toBeNull();
    expect(vm.getGlobal('empty')).toBe(false);
  });
});
