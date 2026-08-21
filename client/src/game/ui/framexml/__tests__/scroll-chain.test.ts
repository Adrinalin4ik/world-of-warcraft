/**
 * THE WHOLE SCROLL CHAIN, walked the way the client's own files walk it.
 *
 * Owner, twice: "На странице со скилами и репутации скрол не работает." Landing `<ThumbTexture>` and
 * making `Slider:SetValue` dispatch `OnValueChanged` was not enough, because step 3 was still silent:
 *
 *   1. arrow <OnClick>          -> scrollBar:SetValue(GetValue() +/- GetValueStep())
 *   2. slider <OnValueChanged>  -> self:GetParent():SetVerticalScroll(value)   uipaneltemplates.xml:203-205
 *   3. frame  <OnVerticalScroll>-> FauxScrollFrame_OnVerticalScroll(self, offset, ...)  skillframe.xml:508-510
 *   4. that sets self.offset and calls the update function        uipaneltemplates.lua:236-243
 *
 * So the value moved and no row ever repainted. This drives 1 -> 4 and asserts the offset a real list
 * would repaint from.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';

describe('the scroll chain', () => {
  it('an arrow click reaches the update function with a new row offset', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const ctx = installObjectModel(vm, registry, null);
    const rt = createFrameXmlRuntime(vm, ctx);

    // The shape of `FauxScrollFrameTemplate` + `UIPanelScrollBarTemplate`, with the client's own
    // handler bodies rather than paraphrases.
    const report = loadDocument(rt, parseXml(`
      <Ui>
        <ScrollFrame name="ListScroll">
          <Size><AbsDimension x="296" y="220"/></Size>
          <ScrollChild>
            <Frame name="$parentScrollChildFrame">
              <Size><AbsDimension x="296" y="640"/></Size>
            </Frame>
          </ScrollChild>
          <Frames>
            <Slider name="$parentScrollBar">
              <Size><AbsDimension x="16" y="200"/></Size>
              <Scripts>
                <OnValueChanged>
                  self:GetParent():SetVerticalScroll(value);
                </OnValueChanged>
              </Scripts>
              <ThumbTexture name="$parentThumbTexture" file="Interface\Buttons\UI-ScrollBar-Knob">
                <Size><AbsDimension x="16" y="24"/></Size>
              </ThumbTexture>
            </Slider>
          </Frames>
          <Scripts>
            <OnVerticalScroll>
              rowOffset = math.floor((offset / 16) + 0.5);
              repaints = (repaints or 0) + 1;
            </OnVerticalScroll>
          </Scripts>
        </ScrollFrame>
      </Ui>
    `), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);

    expect(vm.run('ListScrollScrollBar:SetMinMaxValues(0, 420)', 't')).toBeNull();

    // Step 1: what an arrow button's OnClick does.
    expect(vm.run('ListScrollScrollBar:SetValue(ListScrollScrollBar:GetValue() + 48)', 't')).toBeNull();

    // Steps 2-4 must have run: the offset the list would repaint from is 48/16 = 3 rows down.
    expect(vm.getGlobal('repaints')).toBe(1);
    expect(vm.getGlobal('rowOffset')).toBe(3);
    expect(vm.run('scrolled = ListScroll:GetVerticalScroll()', 't')).toBeNull();
    expect(vm.getGlobal('scrolled')).toBe(48);

    // The chain is CIRCULAR -- step 4 ends in `scrollbar:SetValue(value)` -- so the transition guards
    // are what stop it. An unchanged write must not re-run the handler.
    expect(vm.run('ListScrollScrollBar:SetValue(48)', 't')).toBeNull();
    expect(vm.getGlobal('repaints')).toBe(1);
  });
});
