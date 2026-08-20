/**
 * ONE happy-path test, for one rule that is invisible when it is wrong.
 *
 * `SetVertexColor` means two different things depending on what it is called on, and getting it
 * backwards produces a colour that is plausible rather than absent -- which is why it survived: the
 * loot window's item names came out gold and muddy-grey instead of white and grey, and nothing raised.
 * See `lua/methods/region.ts#SetVertexColor`.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';
import '../lua/methods/region';

function runtime() {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry);
  return { vm, root, registry, rt: createFrameXmlRuntime(vm, ctx) };
}

describe('SetVertexColor', () => {
  it('SETS a font string\'s glyph colour and MULTIPLIES a texture\'s tint', () => {
    const { vm, registry, rt } = runtime();

    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <Frame name="Row">
            <Size><AbsDimension x="100" y="20"/></Size>
            <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="0" y="0"/></Offset></Anchor></Anchors>
            <Layers>
              <Layer level="ARTWORK">
                <FontString name="RowText" text="Refreshing Spring Water"/>
                <Texture name="RowPlate" file="Interface/Buttons/UI-Quickslot2"/>
              </Layer>
            </Layers>
          </Frame>
        </Ui>
      `),
      () => null,
      'vertex-color.test',
    );
    expect(report.errors).toEqual([]);

    // `ITEM_QUALITY_COLORS[1]` -- Common, pure white. This is the case that was invisible: multiplying
    // a gold-rasterized string by white leaves it gold.
    vm.run('RowText:SetVertexColor(1, 1, 1) RowPlate:SetVertexColor(0.5, 0.5, 0.5)', 'test');

    const text = registry.widget(registry.byName('RowText')!)!;
    const plate = registry.widget(registry.byName('RowPlate')!)!;

    expect(text.font?.color).toBe('#ffffff');
    // The quad stays neutral so a second call cannot darken the glyphs twice.
    expect(text.vertexColor).toBe('#ffffff');
    // A texture keeps the multiply -- that is how one greyscale sheet is tinted per state.
    expect(plate.vertexColor).toBe('#808080');
  });
});
