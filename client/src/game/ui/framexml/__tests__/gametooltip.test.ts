/**
 * Two happy-path tests, deliberately -- the owner asked not to over-invest here.
 *
 * They cover the two defects of this round that a screenshot cannot guard against once it has scrolled
 * away: `SetChecked("false")` (which had every spellbook button drawing its checked texture) and
 * `GameTooltip`'s fill (which is a whole frame TYPE that did not exist). Neither is edge-case coverage --
 * both are the exact call the client's own Lua makes.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';
// Side-effect imports: the CHECKBUTTON and GAMETOOLTIP method tables under test.
import '../lua/methods/kinds';
import '../lua/methods/gametooltip';

function runtime() {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry);
  return { vm, root, registry, rt: createFrameXmlRuntime(vm, ctx) };
}

describe('the checked state', () => {
  /**
   * `SpellButton_UpdateSelection` passes the STRINGS `"true"` and `"false"` from the two branches of one
   * decision (`spellbookframe.lua:409-413`). `Boolean("false")` is true, so every one of the twelve
   * spellbook buttons came back checked and drew `CheckButtonHilight` over its icon -- the owner's "every
   * spell renders as if pressed".
   */
  it('reads SetChecked("false") as UNCHECKED, which is what the spellbook passes', () => {
    const { vm, rt } = runtime();
    loadDocument(rt, parseXml(`
      <Ui>
        <CheckButton name="SpellButtonX">
          <Size><AbsDimension x="37" y="37"/></Size>
          <Anchors><Anchor point="TOPLEFT"/></Anchors>
          <CheckedTexture file="Interface\\Buttons\\CheckButtonHilight"/>
        </CheckButton>
      </Ui>
    `), () => null, 'gametooltip.test');

    expect(vm.run('SpellButtonX:SetChecked("true");', 't')).toBeNull();
    expect(vm.runExpr('return SpellButtonX:GetChecked()', 't')).toEqual({ value: true });

    expect(vm.run('SpellButtonX:SetChecked("false");', 't')).toBeNull();
    expect(vm.runExpr('return SpellButtonX:GetChecked()', 't')).toEqual({ value: false });
  });
});

describe('GameTooltip', () => {
  /**
   * The whole hover path in one go: `SetOwner` records the owner and re-anchors, `SetText`/`AddLine` fill
   * the template's `$parentTextLeft<n>` slots, and the frame ends up with a rect that contains them.
   *
   * `GetOwner()` returning the caller's own frame table is what `actionbutton.lua:265`'s
   * `if ( GameTooltip:GetOwner() == self )` compares -- the statement that was raising and taking
   * `ActionButton_ShowGrid`, and with it every droppable empty action slot, down with it.
   */
  it('records its owner, fills the template line slots and sizes itself', () => {
    const { vm, registry, rt } = runtime();
    loadDocument(rt, parseXml(`
      <Ui>
        <Button name="OwnerButton">
          <Size><AbsDimension x="36" y="36"/></Size>
          <Anchors><Anchor point="TOPLEFT"/></Anchors>
        </Button>
        <GameTooltip name="GameTooltip" hidden="true">
          <Layers>
            <Layer level="ARTWORK">
              <FontString name="$parentTextLeft1" hidden="true">
                <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-10"/></Offset></Anchor></Anchors>
              </FontString>
              <FontString name="$parentTextRight1" hidden="true">
                <Anchors><Anchor point="RIGHT" relativeTo="$parentTextLeft1" relativePoint="LEFT"/></Anchors>
              </FontString>
              <FontString name="$parentTextLeft2" hidden="true">
                <Anchors><Anchor point="TOPLEFT" relativeTo="$parentTextLeft1" relativePoint="BOTTOMLEFT"/></Anchors>
              </FontString>
            </Layer>
          </Layers>
        </GameTooltip>
      </Ui>
    `), () => null, 'gametooltip.test');

    expect(vm.run('GameTooltip:SetOwner(OwnerButton, "ANCHOR_RIGHT");', 't')).toBeNull();
    expect(vm.runExpr('return GameTooltip:GetOwner() == OwnerButton', 't')).toEqual({ value: true });
    expect(vm.runExpr('return GameTooltip:IsOwned(OwnerButton)', 't')).toEqual({ value: true });

    expect(vm.run('GameTooltip:SetText("Healing Wave"); GameTooltip:AddLine("Heals a friendly target.");', 't'))
      .toBeNull();
    expect(vm.runExpr('return GameTooltip:NumLines()', 't')).toEqual({ value: 2 });

    const line = (name: string) => registry.widget(registry.byName(name) as number);
    expect(line('GameTooltipTextLeft1')?.text).toBe('Healing Wave');
    expect(line('GameTooltipTextLeft1')?.shown).toBe(true);
    expect(line('GameTooltipTextLeft2')?.text).toBe('Heals a friendly target.');
    expect(line('GameTooltipTextLeft2')?.shown).toBe(true);

    // A rect that could contain two lines plus the template's 10-unit insets. The exact numbers depend on
    // the measured font, which jsdom has no canvas for -- so this asserts the property that matters (the
    // frame is no longer the zero rect that drew nothing) rather than a pixel count.
    const tooltip = line('GameTooltip');
    expect(tooltip?.height).toBeGreaterThan(20);
    // One anchor, the owner's -- `SetOwner` clears whatever the previous owner left, or two opposing
    // anchors make `resolveAnchors` derive the rect and the computed size is ignored.
    expect(tooltip?.anchors).toHaveLength(1);
    expect(tooltip?.anchors[0].point).toBe('TOPLEFT');
    expect(tooltip?.anchors[0].relativePoint).toBe('TOPRIGHT');
  });
});
