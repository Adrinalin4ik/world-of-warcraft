/**
 * `justifyV` -- the vertical placement of a font string's glyphs inside its rect.
 *
 * The loader already routed the XML attribute to `SetJustifyV` (`loader.ts:1100-1102`); the method was a
 * declared gap whose reason was accurate ("FontSpec has no vertical-justify field yet"), so every string
 * drew centred whatever its document asked for. MIDDLE is FrameXML's own default, so this only moves a
 * string whose RECT is taller than its glyph block -- which is exactly the case the client authors it for.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';

describe('justifyV', () => {
  it('reaches the font spec from the XML attribute and reads back', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const ctx = installObjectModel(vm, registry, null);
    const rt = createFrameXmlRuntime(vm, ctx);

    const report = loadDocument(rt, parseXml(`
      <Ui>
        <Frame name="Panel">
          <Size><AbsDimension x="200" y="200"/></Size>
          <Anchors><Anchor point="TOPLEFT"/></Anchors>
          <Layers><Layer level="ARTWORK">
            <FontString name="Top" text="top" justifyV="TOP">
              <Size><AbsDimension x="180" y="60"/></Size>
              <Anchors><Anchor point="TOPLEFT"/></Anchors>
            </FontString>
            <FontString name="Plain" text="plain">
              <Size><AbsDimension x="180" y="60"/></Size>
              <Anchors><Anchor point="BOTTOMLEFT"/></Anchors>
            </FontString>
          </Layer></Layers>
        </Frame>
      </Ui>
    `), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);

    expect(vm.run('top = Top:GetJustifyV(); plain = Plain:GetJustifyV()', 'jv')).toBeNull();
    expect(vm.getGlobal('top')).toBe('TOP');
    // Unset reads back as the FrameXML default rather than nil, which is what the client's own
    // `if ( self:GetJustifyV() == "TOP" )` comparisons expect.
    expect(vm.getGlobal('plain')).toBe('MIDDLE');

    expect(vm.run('Plain:SetJustifyV("BOTTOM"); set = Plain:GetJustifyV()', 'jv2')).toBeNull();
    expect(vm.getGlobal('set')).toBe('BOTTOM');
  });
});
