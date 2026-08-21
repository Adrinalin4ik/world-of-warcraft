/**
 * THE RANGE, which is upstream of every scroll input.
 *
 * `QuestDetailScrollChildFrame` is authored 300x334 inside a 300x334 viewport
 * (`questframe.xml:344-348`) and NOTHING resizes it -- `QuestInfo_Display` only `SetPoint`s its elements
 * (`questinfo.lua:68-80`). So a range measured from the child's own height is structurally 0, the
 * slider's max is 0, `SetValue` clamps everything to 0, and the arrows, the drag and the thumb's travel
 * are all correctly dead. One cause, three symptoms.
 *
 * The engine measures the child's actual EXTENT, descendants included. And it fires
 * `OnScrollRangeChanged` from its layout pass -- the only thing that calls
 * `scrollbar:SetMinMaxValues(0, yrange)` (`uipaneltemplates.lua:275-285`) -- which nothing here fired.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';
import { publishRects, setRectResolver, clearRects } from '../../rects';
import { reconcileScrollRanges } from '../lua/methods/scroll';

const VIEWPORT = { width: 1024, height: 768 };

describe('a real ScrollFrame range', () => {
  afterEach(() => {
    setRectResolver(null);
    clearRects();
  });

  it('comes from the child CONTENT, and is announced so the scrollbar gets a range', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const ctx = installObjectModel(vm, registry, null);
    const rt = createFrameXmlRuntime(vm, ctx);
    setRectResolver(() => root.layoutRects(VIEWPORT));

    // The quest page's shape: a scroll child the same size as its viewport, with content overflowing it.
    const report = loadDocument(rt, parseXml(`
      <Ui>
        <ScrollFrame name="Detail">
          <Size><AbsDimension x="300" y="334"/></Size>
          <Anchors><Anchor point="TOPLEFT"/></Anchors>
          <Scripts>
            <OnScrollRangeChanged>
              announced = yrange;
            </OnScrollRangeChanged>
          </Scripts>
          <ScrollChild>
            <Frame name="$parentChild">
              <Size><AbsDimension x="300" y="334"/></Size>
              <Layers><Layer level="ARTWORK">
                <FontString name="Body" text="body">
                  <Size><AbsDimension x="285" y="600"/></Size>
                  <Anchors><Anchor point="TOPLEFT"/></Anchors>
                </FontString>
              </Layer></Layers>
            </Frame>
          </ScrollChild>
        </ScrollFrame>
      </Ui>
    `), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);

    // The child's own height would give 334 - 334 = 0. Its CONTENT is 600, so the range is 266.
    expect(vm.run('range = Detail:GetVerticalScrollRange()', 't')).toBeNull();
    expect(Math.round(vm.getGlobal('range') as number)).toBe(266);

    // And the layout pass announces it -- which is what `ScrollFrame_OnScrollRangeChanged` needs in
    // order to give the scrollbar its min/max. Nothing fired this before.
    publishRects(root.drawList(VIEWPORT), VIEWPORT.height);
    reconcileScrollRanges(ctx);
    expect(Math.round(vm.getGlobal('announced') as number)).toBe(266);

    // With a range, a value now actually moves -- which is the arrows' and the drag's precondition.
    expect(vm.run('Detail:SetVerticalScroll(120); got = Detail:GetVerticalScroll()', 't')).toBeNull();
    expect(vm.getGlobal('got')).toBe(120);
  });
});
