/**
 * `FontString:GetFont()`.
 *
 * Measured absent, not guessed at: loading the client's own `UIDropDownMenu.xml` through the real
 * loader in a headless harness reported exactly one error, `DropDownList1: OnLoad: attempt to call a
 * nil value (method 'GetFont')`. That handler is
 * `_G["DropDownList1Button1NormalText"]:GetFont()` -> `UIDROPDOWNMENU_DEFAULT_TEXT_HEIGHT`
 * (`uidropdownmenu.xml:11-14`), so the raise killed the rest of it.
 *
 * One test, on the round trip that matters: what `SetFont` takes, `GetFont` gives back.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';

describe('FontString:GetFont', () => {
  it('answers the fontFile, height and flags triple SetFont was given', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const ctx = installObjectModel(vm, registry, null);
    const rt = createFrameXmlRuntime(vm, ctx);

    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <Frame name="Holder">
            <Size><AbsDimension x="100" y="40"/></Size>
            <Layers><Layer level="ARTWORK">
              <FontString name="Label" text="x"/>
            </Layer></Layers>
          </Frame>
        </Ui>
      `),
      () => null,
      'inline.xml',
    );
    expect(report.errors).toEqual([]);

    const error = vm.run(`
      Label:SetFont("Fonts\\\\FRIZQT__.TTF", 14, "OUTLINE");
      gotFile, gotHeight, gotFlags = Label:GetFont();
    `, 'get-font');

    expect(error).toBeNull();
    expect(vm.getGlobal('gotFile')).toBe('Fonts\\FRIZQT__.TTF');
    expect(vm.getGlobal('gotHeight')).toBe(14);
    expect(vm.getGlobal('gotFlags')).toBe('OUTLINE');
  });
});
