/**
 * `SetParent` LEAVES A DEFAULT FILL DEFAULT -- the interaction between two fixes, which broke both.
 *
 * `684b68b` made the loader's implicit fill for an anchorless `<Layer>` region a DEFAULT that the
 * first explicit `SetPoint` REPLACES. `35b2936` made `SetParent` re-point anchors that named the old
 * parent, because a reparented region was keeping an anchor to its authoring parent and resolving to a
 * negative height.
 *
 * Together they cancelled: `Widget#setAnchors` clears `anchorsAreDefault` by design ("any explicit
 * call is an authored placement", `widget.ts:563-565`), so re-pointing a DEFAULT fill promoted it to an
 * explicit anchor set, and the `SetPoint` that `QuestInfo_Display` issues two statements after its
 * `SetParent` then merged with the fill instead of replacing it. The quest title resolved to the whole
 * 295x324 viewport again and everything chained below its `BOTTOMLEFT` fell under the fold.
 *
 * Measured in the headless manifest harness, which is how it was caught: with the guard, the detail
 * panel's title, description, objectives, rewards frame and first reward button ALL draw inside the
 * scroll viewport (285x14 at y=195, y=214, y=262, y=291 and 147x41 at y=343); without it, only the
 * title drew, at 295x324.
 *
 * ONE test, because there is one rule: a default fill is not an authored placement and re-parenting is
 * not an authored placement either, so neither may consume the other's flag.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { Widget, WidgetRoot } from '../../widget';

/** The shape `questinfo.xml` authors, plus a second frame to reparent INTO. */
const DOC = `
  <Ui>
    <Frame name="Owner">
      <Size><AbsDimension x="295" y="324"/></Size>
      <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="0" y="0"/></Offset></Anchor></Anchors>
      <Layers><Layer level="ARTWORK">
        <FontString name="Title" text="Quest title"><Size><AbsDimension x="285" y="0"/></Size></FontString>
      </Layer></Layers>
    </Frame>
    <Frame name="ScrollChild">
      <Size><AbsDimension x="300" y="334"/></Size>
      <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="23" y="-185"/></Offset></Anchor></Anchors>
    </Frame>
  </Ui>
`;

test('SetParent does not promote a default fill to an authored placement', () => {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry, null);
  const rt = createFrameXmlRuntime(vm, ctx);
  expect(loadDocument(rt, parseXml(DOC), () => null, 'inline.xml').errors).toEqual([]);
  const widget = (n: string) => registry.widget(registry.byName(n)!) as Widget;

  // The loader filled it, and that fill is a DEFAULT.
  expect(widget('Title').anchorsAreDefault).toBe(true);
  const filled = widget('Title').anchors.length;
  expect(filled).toBeGreaterThan(1);

  // `QuestInfo_Display`'s own two statements, in its own order.
  expect(vm.run('Title:SetParent(ScrollChild)', 'p.lua')).toBeNull();
  // STILL a default -- this is the assertion the whole file exists for.
  expect(widget('Title').anchorsAreDefault).toBe(true);

  expect(vm.run('Title:SetPoint("TOPLEFT", ScrollChild, "TOPLEFT", 5, -10)', 'q.lua')).toBeNull();
  // The explicit placement REPLACED the fill rather than stacking on it, so the region carries exactly
  // one anchor and can take its height from its text instead of spanning the parent.
  expect(widget('Title').anchorsAreDefault).toBe(false);
  expect(widget('Title').anchors).toEqual([
    { point: 'TOPLEFT', relativePoint: 'TOPLEFT', relativeTo: widget('ScrollChild').id, x: 5, y: -10 },
  ]);
});
