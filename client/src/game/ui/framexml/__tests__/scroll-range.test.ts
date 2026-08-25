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
import { WidgetRoot, FontSpec } from '../../widget';
import { publishRects, setRectResolver, clearRects } from '../../rects';
import { reconcileScrollRanges } from '../lua/methods/scroll';

const VIEWPORT = { width: 1024, height: 768 };


/**
 * A stand-in for `text.ts#measureText`, which cannot run here -- it imports three.js and rasterizes on
 * a canvas (`widget.ts:680-688` records exactly why the real one is injected rather than imported).
 * Monospace arithmetic at 6 units a character, wrapped at the font's budget and capped by `maxLines`,
 * which is all `deriveSize` needs to turn text into a height.
 *
 * WITHOUT a measure function `deriveSize` returns the authored size untouched, so a `<Size y="0">`
 * string stays 0 tall however much text it holds -- and every scroll range computed over it is 0. That
 * is a property of the harness, not of the client, and it is why the first version of this test could
 * not see the defect.
 */
const measure = (text: string, font: FontSpec, scale: number) => {
  const size = (font.size ?? 10) * scale;
  const charWidth = 6 * scale;
  const budget = font.wrapWidth === undefined ? Infinity : font.wrapWidth * scale;
  const perLine = Math.max(1, Math.floor(budget / charWidth));
  const lines = Math.min(font.maxLines ?? Infinity, Math.max(1, Math.ceil(text.length / perLine)));
  const spacing = (font.spacing ?? 0) * scale;
  return {
    width: Math.min(budget === Infinity ? text.length * charWidth : budget, text.length * charWidth),
    height: lines * size + (lines - 1) * spacing,
  };
};

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
    setRectResolver(() => root.layoutRects(VIEWPORT, measure));

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
    publishRects(root.drawList(VIEWPORT, measure), VIEWPORT.height);
    reconcileScrollRanges(ctx);
    expect(Math.round(vm.getGlobal('announced') as number)).toBe(266);

    // With a range, a value now actually moves -- which is the arrows' and the drag's precondition.
    expect(vm.run('Detail:SetVerticalScroll(120); got = Detail:GetVerticalScroll()', 't')).toBeNull();
    expect(vm.getGlobal('got')).toBe(120);
  });

  /**
   * THE LIVE ORDERING, which my first test did not reproduce and which is why a landed fix was inert.
   *
   * Live, the manifest loads and the ranges reconcile ONCE with no quest text; the player then opens a
   * quest and `SetText` fills it. `deriveSize` measures a FontString whose dimension is 0 -- and the
   * client authors exactly that (`questinfo.xml:251-262`, `<Size x="285" y="0">`) -- so real heights
   * change. Nothing bumped `geometryRevision`, so `reconcileScrollRanges` skipped and the scrollbar kept
   * its 0..0 range for ever.
   *
   * My first test called reconcile once, AFTER building, inside the epoch where the geometry was already
   * final. It could not have caught this. This one reconciles first, then sets text, then reconciles
   * again -- which is the sequence the live client performs.
   */
  it('re-announces after SetText changes a derived height', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const ctx = installObjectModel(vm, registry, null);
    const rt = createFrameXmlRuntime(vm, ctx);
    setRectResolver(() => root.layoutRects(VIEWPORT, measure));

    const report = loadDocument(rt, parseXml(`
      <Ui>
        <ScrollFrame name="Detail">
          <Size><AbsDimension x="300" y="334"/></Size>
          <Anchors><Anchor point="TOPLEFT"/></Anchors>
          <Scripts><OnScrollRangeChanged>announced = yrange;</OnScrollRangeChanged></Scripts>
          <ScrollChild>
            <Frame name="$parentChild">
              <Size><AbsDimension x="300" y="334"/></Size>
              <Layers><Layer level="ARTWORK">
                <FontString name="Body">
                  <Size><AbsDimension x="285" y="0"/></Size>
                  <Anchors><Anchor point="TOPLEFT"/></Anchors>
                </FontString>
              </Layer></Layers>
            </Frame>
          </ScrollChild>
        </ScrollFrame>
      </Ui>
    `), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);

    // Load-time reconcile: no text yet, so nothing overflows. Seeded with a sentinel rather than
    // asserting the first announcement -- `reconcileScrollRanges` keeps module state across tests in
    // this file, so whether the zero-range case announces here depends on test order, and what this
    // test is about is the RE-announcement below.
    // A FontString with no font derives nothing (`deriveSize` returns early on `!widget.font`). Live
    // this comes from `inherits="QuestFont"`; the harness loads no font styles, so set one explicitly --
    // before the first reconcile, so it belongs to the load epoch and not to the change under test.
    expect(vm.run('assert(Body:SetFont("Fonts/FRIZQT__.TTF", 10))', 't')).toBeNull();
    expect(vm.run('announced = -1', 't')).toBeNull();
    publishRects(root.drawList(VIEWPORT, measure), VIEWPORT.height);
    reconcileScrollRanges(ctx);
    expect(vm.getGlobal('announced') as number).toBeLessThanOrEqual(0);

    // The quest opens. A DERIVED height changes, which is geometry even though no size was set.
    expect(vm.run('Body:SetText(string.rep("a long line of quest text ", 200))', 't')).toBeNull();


    publishRects(root.drawList(VIEWPORT, measure), VIEWPORT.height);
    reconcileScrollRanges(ctx);
    // Without the `SetText` bump this stayed 0 for ever -- and with a 0..0 slider every input is dead.
    expect(vm.getGlobal('announced') as number).toBeGreaterThan(0);
  });
});
