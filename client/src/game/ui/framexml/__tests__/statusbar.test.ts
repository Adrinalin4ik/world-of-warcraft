/**
 * Two happy-path tests, deliberately: the owner asked not to over-invest in tests here.
 *
 * They cover the two things that are genuinely new behaviour rather than plumbing -- the status-bar
 * fill's geometry (which is the piece a naive port gets wrong invisibly) and the unit-token seam.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';
import { Viewport } from '../../layout';
import { installUnitsApi, setUnit, emptySnapshot } from '../lua/api/units';
import { installActionsApi, setBonusBarOffset } from '../lua/api/actions';
import { readUnitFields } from '../../../../network/game/object/update-object/unit-fields';
// Side-effect import: registers the STATUSBAR method table, whose `OnValueChanged` dispatch is what
// the first test below covers.
import '../lua/methods/statusbar';

const VIEWPORT: Viewport = { width: 1024, height: 768 };

function runtime() {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry);
  return { vm, root, registry, rt: createFrameXmlRuntime(vm, ctx) };
}

describe('StatusBar', () => {
  it('fills its frame rect by the value fraction and CROPS the art rather than squeezing it', () => {
    const { vm, root, rt } = runtime();

    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <StatusBar name="HealthBar" minValue="0" maxValue="200" defaultValue="50">
            <Size><AbsDimension x="100" y="20"/></Size>
            <Anchors>
              <Anchor point="TOPLEFT"><Offset><AbsDimension x="0" y="0"/></Offset></Anchor>
            </Anchors>
            <BarTexture file="Interface\\TargetingFrame\\UI-StatusBar"/>
            <BarColor r="1" g="0" b="0"/>
          </StatusBar>
        </Ui>
      `),
      () => null,
      'statusbar.test',
    );
    expect(report.errors).toEqual([]);

    // The bar itself must not be reported as a gap any more.
    expect(vm.run('assert(HealthBar:GetValue() == 50)', 'check')).toBeNull();
    expect(vm.run('assert(select(2, HealthBar:GetMinMaxValues()) == 200)', 'check')).toBeNull();

    const items = root.drawList(VIEWPORT);
    // Found by the `statusBar` slot rather than by widget id: the widget's string id is minted by
    // `Widget`'s constructor and is not the FrameXML name.
    const frame = items.find((item) => item.widget.statusBar !== null)!;
    expect(frame).toBeDefined();
    const fill = items.find((item) => item.widget === frame.widget.statusBar!.bar)!;
    expect(fill).toBeDefined();

    // 50/200 = one quarter of the frame's width, anchored at its left edge, full height.
    expect(fill.rect.left).toBeCloseTo(frame.rect.left);
    expect(fill.rect.width).toBeCloseTo(frame.rect.width * 0.25);
    expect(fill.rect.height).toBeCloseTo(frame.rect.height);

    // ...and the UVs are cropped to the same quarter, NOT left at 0..1. This is the assertion that
    // catches a squeeze: a squeezed bar has the right rect and the wrong texture coordinates.
    expect(fill.texCoords).toEqual({ u0: 0, u1: 0.25, v0: 0, v1: 1 });
  });
});

describe('unit engine globals', () => {
  it('answers from the host snapshot, and reports a token with no snapshot as not existing', () => {
    const vm = new LuaVM();
    installUnitsApi(vm);

    // Nothing pushed yet: the token does not exist, which is what TargetFrame_Update tests first.
    expect(vm.run('assert(UnitExists("target") == false)', 'check')).toBeNull();
    expect(vm.run('assert(UnitName("target") == nil)', 'check')).toBeNull();

    setUnit(vm, 'target', {
      ...emptySnapshot(),
      name: 'Goldtooth',
      level: 7,
      health: 60,
      maxHealth: 120,
      powerType: 1, // rage
      power: 30,
      maxPower: 100,
      reaction: 2, // hostile
      classification: 'rareelite',
      isPlayer: false,
    });

    expect(vm.run('assert(UnitExists("target"))', 'check')).toBeNull();
    expect(vm.run('assert(UnitName("target") == "Goldtooth")', 'check')).toBeNull();
    expect(vm.run('assert(UnitLevel("target") == 7)', 'check')).toBeNull();
    expect(vm.run('assert(UnitHealth("target") == 60)', 'check')).toBeNull();
    expect(vm.run('assert(UnitHealthMax("target") == 120)', 'check')).toBeNull();
    // The power TYPE, which is the field a unit frame needs to pick a colour and a scale.
    expect(vm.run('assert(UnitPowerType("target") == 1)', 'check')).toBeNull();
    expect(vm.run('assert(UnitPower("target") == 30)', 'check')).toBeNull();
    expect(vm.run('assert(UnitClassification("target") == "rareelite")', 'check')).toBeNull();
    // Reaction below the neutral point of 4 means hostile, and the derived pair must agree with it.
    expect(vm.run('assert(UnitReaction("target") == 2)', 'check')).toBeNull();
    expect(vm.run('assert(UnitIsEnemy("player", "target"))', 'check')).toBeNull();
    expect(vm.run('assert(UnitIsFriend("player", "target") == false)', 'check')).toBeNull();

    setUnit(vm, 'target', null);
    expect(vm.run('assert(UnitExists("target") == false)', 'check')).toBeNull();
  });
});

/**
 * The two mechanisms that were the whole of "the action bar is empty and the XP bar is invisible".
 * One test each, happy path, per this file's own header.
 */
describe('the action bar the server actually sent', () => {
  it('fires OnValueChanged only when the value moves, which is what re-shows a TextStatusBar', () => {
    const { vm, rt } = runtime();
    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <StatusBar name="XpBar">
            <Size><AbsDimension x="100" y="10"/></Size>
            <Anchors><Anchor point="TOPLEFT"/></Anchors>
            <Scripts>
              <OnValueChanged>
                fired = (fired or 0) + 1
                lastValue = value
              </OnValueChanged>
            </Scripts>
          </StatusBar>
        </Ui>
      `),
      () => null,
      'onvaluechanged.test',
    );
    expect(report.errors).toEqual([]);

    // `MainMenuExpBar_Update`'s own two calls (`MainMenuBar.lua:9-10`), in order.
    expect(vm.run('XpBar:SetMinMaxValues(0, 400) XpBar:SetValue(280)', 'check')).toBeNull();
    expect(vm.run('assert(lastValue == 280, "lastValue " .. tostring(lastValue))', 'check')).toBeNull();

    // Re-setting the SAME value fires nothing: the change gate is what stops a scrollbar's
    // OnValueChanged/SetValue pair recursing, and what keeps a 60 Hz bar from repainting text.
    const before = vm.run('countBefore = fired', 'check');
    expect(before).toBeNull();
    expect(vm.run('XpBar:SetValue(280) assert(fired == countBefore, "fired again")', 'check')).toBeNull();
  });

  it('reads the shapeshift form out of UNIT_FIELD_BYTES_2 byte 3, which picks the bonus bar', () => {
    // Battle Stance is form 17 and `SpellShapeshiftForm.dbc` gives it `bonusActionBar` 1, so an
    // `isBonus` button lands on 1-based slots 73-84 -- where the server put this build's warrior
    // buttons. The byte offset is TrinityCore 3.3.5's `UNIT_BYTES_2_OFFSET_SHAPESHIFT_FORM = 3`.
    const fields = readUnitFields({ unit_field_bytes_2: (17 << 24) | 0x01 });
    expect(fields.shapeshiftForm).toBe(17);

    // And the engine global the client's own `ActionButton_CalculateAction` multiplies by: pushed by
    // the host, 0 until then.
    const vm = new LuaVM();
    installActionsApi(vm);
    expect(vm.run('assert(GetBonusBarOffset() == 0)', 'check')).toBeNull();
    expect(setBonusBarOffset(vm, 1)).toBe(true);
    expect(vm.run('assert(GetBonusBarOffset() == 1)', 'check')).toBeNull();
    // Same value again is not a change -- the host fires `UPDATE_BONUS_ACTIONBAR` off this answer.
    expect(setBonusBarOffset(vm, 1)).toBe(false);
  });
});
