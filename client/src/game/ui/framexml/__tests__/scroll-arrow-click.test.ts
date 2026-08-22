/**
 * THE ARROW CLICK, through the REAL document shape -- inheritance and a click, not a direct `SetValue`.
 *
 * `scroll-chain.test.ts` drives the same chain but declares every handler INLINE and calls `SetValue`
 * itself, so two links the client actually relies on were never covered:
 *
 *  - the slider's `<OnValueChanged>` arrives by `inherits="UIPanelScrollBarTemplate"`, not inline
 *    (`uipaneltemplates.xml:202-206`, on the VIRTUAL template; `:287` is the inheriting instance);
 *  - it is an arrow `<OnClick>` that starts it (`:181-187`), not a Lua caller.
 *
 * Owner, with the thumb-name fix in his build: "кнопка скрола стала активной, даже могу кликнуть, но не
 * скролит". The button being enabled proves `ScrollFrame_OnScrollRangeChanged` now runs to completion, so
 * the range and the bar's max are right -- which leaves exactly these two links.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { Widget, WidgetRoot } from '../../widget';
import { setRectResolver, clearRects } from '../../rects';

const VIEWPORT = { width: 1024, height: 768 };

/** The real shape: a virtual scrollbar template inherited by an instance inside a `<ScrollFrame>`. */
const DOCUMENT = `
      <Ui>
        <Slider name="BarTemplate" virtual="true">
          <Size><AbsDimension x="16" y="0"/></Size>
          <Frames>
            <Button name="$parentScrollDownButton">
              <Size><AbsDimension x="16" y="16"/></Size>
              <Anchors><Anchor point="TOP" relativePoint="BOTTOM"/></Anchors>
              <Scripts>
                <OnClick>
                  local parent = self:GetParent();
                  parent:SetValue(parent:GetValue() + (parent:GetHeight() / 2));
                </OnClick>
              </Scripts>
            </Button>
          </Frames>
          <Scripts>
            <OnValueChanged>
              self:GetParent():SetVerticalScroll(value);
            </OnValueChanged>
          </Scripts>
          <ThumbTexture name="$parentThumbTexture" file="knob">
            <Size><AbsDimension x="18" y="24"/></Size>
          </ThumbTexture>
        </Slider>

        <ScrollFrame name="Detail">
          <Size><AbsDimension x="300" y="334"/></Size>
          <Anchors><Anchor point="TOPLEFT"/></Anchors>
          <Frames>
            <Slider name="$parentScrollBar" inherits="BarTemplate">
              <Anchors>
                <Anchor point="TOPLEFT" relativePoint="TOPRIGHT"/>
                <Anchor point="BOTTOMLEFT" relativePoint="BOTTOMRIGHT"/>
              </Anchors>
            </Slider>
          </Frames>
          <ScrollChild>
            <Frame name="$parentChild">
              <Size><AbsDimension x="300" y="334"/></Size>
              <Layers><Layer level="ARTWORK">
                <Texture name="Body">
                  <Size><AbsDimension x="285" y="600"/></Size>
                  <Anchors><Anchor point="TOPLEFT"/></Anchors>
                </Texture>
              </Layer></Layers>
            </Frame>
          </ScrollChild>
        </ScrollFrame>
      </Ui>
    `;

describe('an arrow click on an inherited scrollbar', () => {
  afterEach(() => clearRects());

  it('reaches the scroll frame through the template OnValueChanged', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const ctx = installObjectModel(vm, registry, null);
    const rt = createFrameXmlRuntime(vm, ctx);
    setRectResolver(() => root.layoutRects(VIEWPORT));

    const report = loadDocument(rt, parseXml(DOCUMENT), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);

    // What `ScrollFrame_OnScrollRangeChanged` does once it survives to the end (`uipaneltemplates.lua:284`).
    expect(vm.run('DetailScrollBar:SetMinMaxValues(0, 266)', 't')).toBeNull();

    // The gesture: a real click on the arrow, which is where the client's chain starts.
    expect(vm.run('DetailScrollBarScrollDownButton:Click("LeftButton")', 't')).toBeNull();

    // The bar's own value moved -- `GetHeight()/2` of a 334-tall bar, which was 0 before the fix.
    expect(vm.run('value = DetailScrollBar:GetValue()', 't')).toBeNull();
    expect(vm.getGlobal('value')).toBe(167);

    // And the transition carried through the inherited `<OnValueChanged>` to the frame.
    expect(vm.run('moved = Detail:GetVerticalScroll()', 't')).toBeNull();
    expect(vm.getGlobal('moved')).toBe(167);
  });

  /**
   * THE DRAG, which no `<Slider>` script implements -- it is the engine's, so `ui/input.ts` owns the
   * gesture and `Widget#onSliderDrag` is its only way back into Lua. Asserted through that hook rather
   * than through a synthetic pointer sequence: the hook IS the contract between the two layers, and a
   * fake `pointerdown` would test the harness's event plumbing instead.
   */
  it('drags the thumb through the same SetValue an arrow click uses', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const ctx = installObjectModel(vm, registry, null);
    const rt = createFrameXmlRuntime(vm, ctx);
    setRectResolver(() => root.layoutRects(VIEWPORT));

    const report = loadDocument(rt, parseXml(DOCUMENT), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);
    expect(vm.run('DetailScrollBar:SetMinMaxValues(0, 266)', 't')).toBeNull();

    // The slider the loader built, found the way the input layer finds it: by the hook being installed.
    const withDrag: Widget[] = [];
    const walk = (node: Widget): void => {
      if (node.onSliderDrag !== null) {
        withDrag.push(node);
      }
      node.children.forEach(walk);
    };
    walk(root.root);
    expect(withDrag).toHaveLength(1);

    // Half way down the track.
    withDrag[0].onSliderDrag!(0.5);

    expect(vm.run('value = DetailScrollBar:GetValue(); moved = Detail:GetVerticalScroll()', 't')).toBeNull();
    expect(vm.getGlobal('value')).toBe(133);
    expect(vm.getGlobal('moved')).toBe(133);
  });
});
