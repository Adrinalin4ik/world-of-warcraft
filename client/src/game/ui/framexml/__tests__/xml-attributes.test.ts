/**
 * `<Attributes><Attribute/></Attributes>`, which nothing read before.
 *
 * The owner's console log carried
 * `OnAttributeChanged(panel-update): UIParent.lua:1717: attempt to perform arithmetic on a nil value`,
 * and that line is `leftOffset + UIParent:GetAttribute("DEFAULT_FRAME_WIDTH") * 2`. `uiparent.xml:5-12`
 * declares six such attributes; with the block ignored they all read nil and the whole panel-layout
 * pass died on its first arithmetic.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';

describe('XML <Attributes>', () => {
  it('seeds number, boolean and string attributes before OnLoad runs', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const ctx = installObjectModel(vm, registry, null);
    const rt = createFrameXmlRuntime(vm, ctx);

    const report = loadDocument(rt, parseXml(`
      <Ui>
        <Frame name="Panel">
          <Attributes>
            <Attribute name="DEFAULT_FRAME_WIDTH" type="number" value="384"/>
            <Attribute name="showParty" type="boolean" value="true"/>
            <Attribute name="showRaid" type="boolean" value="false"/>
            <Attribute name="label" value="plain"/>
          </Attributes>
          <Scripts>
            <OnLoad>
              atLoad = self:GetAttribute("DEFAULT_FRAME_WIDTH");
            </OnLoad>
          </Scripts>
        </Frame>
      </Ui>
    `), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);

    // The arithmetic that was raising: a number, not a string, or `* 2` gives NaN.
    expect(vm.run('width = Panel:GetAttribute("DEFAULT_FRAME_WIDTH") * 2', 't')).toBeNull();
    expect(vm.getGlobal('width')).toBe(768);
    // Visible to the frame's own OnLoad, which is why they are applied before <Scripts>.
    expect(vm.getGlobal('atLoad')).toBe(384);
    // `"false"` is a non-empty string and would come out TRUE if it were not coerced.
    expect(vm.run('party = Panel:GetAttribute("showParty"); raid = Panel:GetAttribute("showRaid")', 't'))
      .toBeNull();
    expect(vm.getGlobal('party')).toBe(true);
    expect(vm.getGlobal('raid')).toBe(false);
    expect(vm.run('label = Panel:GetAttribute("label")', 't')).toBeNull();
    expect(vm.getGlobal('label')).toBe('plain');
  });
});
