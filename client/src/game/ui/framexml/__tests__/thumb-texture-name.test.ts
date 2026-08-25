/**
 * THE THUMB'S GLOBAL NAME, which is what the client indexes to give a scrollbar its limits.
 *
 * `loader.ts#applySliderThumb` read `<ThumbTexture>`'s `file=` and dropped its `name=`, so the region
 * existed in our object model with no global. `ScrollFrame_OnScrollRangeChanged` reaches it only by that
 * global -- `_G[scrollbar:GetName().."ThumbTexture"]:Hide()` at `uipaneltemplates.lua:300` and `:Show()`
 * at `:305` -- so every announcement raised, on both the zero-range and the non-zero-range branch.
 *
 * The truncation is the whole reported symptom. `:284`'s `SetMinMaxValues` runs BEFORE the throw, so the
 * range was right and every static check of the range chain passed; `:311`'s `ScrollDownButton:Enable()`
 * and `:305`'s `ThumbTexture:Show()` come after it and never ran, leaving both arrows disabled from
 * `ScrollFrame_OnLoad` and no thumb to drag. One dropped attribute, three dead input routes.
 *
 * Asserting the client's own idiom rather than the global's presence: what broke was the INDEX-then-call,
 * and a test that only checked `_G[...] ~= nil` would pass on a value that is not a region.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';

describe("a <Slider>'s <ThumbTexture>", () => {
  it('is reachable by the global name the client indexes', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const ctx = installObjectModel(vm, registry, null);
    const rt = createFrameXmlRuntime(vm, ctx);

    // `UIPanelScrollBarTemplate`'s own shape (`uipaneltemplates.xml:172,207-212`).
    const report = loadDocument(rt, parseXml(`
      <Ui>
        <Slider name="DetailScrollBar">
          <Size><AbsDimension x="16" y="200"/></Size>
          <Anchors><Anchor point="TOPLEFT"/></Anchors>
          <ThumbTexture name="$parentThumbTexture" file="Interface\Buttons\UI-ScrollBar-Knob">
            <Size><AbsDimension x="16" y="24"/></Size>
          </ThumbTexture>
        </Slider>
      </Ui>
    `), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);

    // Verbatim the call that raised in the owner's console.
    expect(vm.run(
      'local t = _G[DetailScrollBar:GetName() .. "ThumbTexture"]; t:Hide(); shown = t:IsShown()',
      'thumb',
    )).toBeNull();
    expect(vm.getGlobal('shown')).toBe(false);
  });
});
