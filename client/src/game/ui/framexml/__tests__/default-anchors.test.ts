/**
 * The loader's implicit fill for an anchorless `<Layer>` region is a DEFAULT, and the first explicit
 * `SetPoint` replaces it rather than stacking on it.
 *
 * `loader.ts`' own comment predicted this and said "nothing observable rests on it today". Something
 * did: `QuestInfo_Display` positions every element with a single `SetPoint` and no `ClearAllPoints`
 * (`questinfo.lua:73,75`), so four fill anchors plus that one gave OPPOSING edges and
 * `QuestInfoTitleHeader` resolved to the whole 295x324 viewport instead of its text height -- putting
 * everything chained below its `BOTTOMLEFT` under the fold, where the scroll clip dropped it.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { Widget, WidgetRoot } from '../../widget';

const VIEWPORT = { width: 1024, height: 768 };

function boot(xml: string) {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry, null);
  const rt = createFrameXmlRuntime(vm, ctx);
  const report = loadDocument(rt, parseXml(xml), () => null, 'inline.xml');
  expect(report.errors).toEqual([]);
  return {
    vm,
    root,
    widget: (n: string) => registry.widget(registry.byName(n)!) as Widget,
  };
}

/** The shape `questinfo.xml` authors: a sized, ANCHORLESS FontString inside a `<Layer>`. */
const DOC = `
  <Ui>
    <Frame name="Holder">
      <Size><AbsDimension x="295" y="324"/></Size>
      <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="0" y="0"/></Offset></Anchor></Anchors>
      <Layers><Layer level="ARTWORK">
        <FontString name="Title" text="Quest title"><Size><AbsDimension x="285" y="0"/></Size></FontString>
        <Texture name="Parchment" file="Interface\QuestFrame\QuestBG"/>
      </Layer></Layers>
    </Frame>
  </Ui>
`;

describe('the loader fill is a default', () => {
  it('a single SetPoint replaces it, so the region is its own size and not the parent rect', () => {
    const { vm, root, widget } = boot(DOC);
    // The fill is in place until something places the region -- which is what a parchment relies on.
    expect(widget('Title').anchors.length).toBe(2);
    expect(widget('Title').anchorsAreDefault).toBe(true);

    // Exactly what `QuestInfo_Display` does: ONE SetPoint, no ClearAllPoints.
    expect(vm.run('Title:SetPoint("TOPLEFT", Holder, "TOPLEFT", 5, -5)', 't')).toBeNull();

    // One anchor, not five. Stacked, the opposing edges made this the whole 295x324 viewport.
    expect(widget('Title').anchors.length).toBe(1);
    expect(widget('Title').anchorsAreDefault).toBe(false);

    const items = root.drawList(VIEWPORT);
    const title = items.find((item) => item.widget === widget('Title'));
    expect(title).toBeDefined();
    // Its authored width, and a height derived from its text -- NOT the parent's 324.
    expect(Math.round(title!.rect.width)).toBe(285);
    expect(title!.rect.height).toBeLessThan(324);
  });

  it('leaves a region nothing positions filling its parent', () => {
    const { root, widget } = boot(DOC);
    const items = root.drawList(VIEWPORT);
    const parchment = items.find((item) => item.widget === widget('Parchment'));
    expect(parchment).toBeDefined();
    // The case the coordinator warned about: a background that relies on the fill still gets it.
    expect(Math.round(parchment!.rect.width)).toBe(295);
    expect(Math.round(parchment!.rect.height)).toBe(324);
  });
});
