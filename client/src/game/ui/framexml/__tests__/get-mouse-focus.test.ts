/**
 * `GetMouseFocus()` -- the frame under the pointer.
 *
 * Measured absent from the owner's console log: `VehicleMenuBar.lua:846` raised on it and took
 * `VehicleMenuBarPowerBar`'s `OnValueChanged` down with it. An engine global that the input router had
 * been able to answer all along (`GlueInput#pointerWidget`); this pins the wiring.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { GlueInput } from '../../input';
import { WidgetRoot } from '../../widget';

describe('GetMouseFocus', () => {
  it('names the frame the pointer is over, and nil when it is over nothing', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const input = new GlueInput(document.createElement('canvas'));
    const ctx = installObjectModel(vm, registry, input);
    const rt = createFrameXmlRuntime(vm, ctx);

    const report = loadDocument(rt, parseXml(`
      <Ui>
        <Button name="Hovered" setAllPoints="true">
          <Scripts><OnClick>x=1</OnClick></Scripts>
        </Button>
      </Ui>
    `), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);

    const widget = registry.widget(registry.byName('Hovered')!)!;

    // Nothing hovered yet: the honest nil, which is also what a pointer over the world answers.
    expect(vm.run('focus = GetMouseFocus()', 't')).toBeNull();
    // The VM marshals a Lua nil as undefined; either spelling means "over nothing".
    expect(vm.getGlobal('focus') ?? null).toBeNull();

    // The router is the only source; drive it the way `input.ts#onPointerMove` does.
    (input as unknown as { hovered: unknown }).hovered = widget;
    expect(vm.run('focusName = GetMouseFocus():GetName()', 't')).toBeNull();
    expect(vm.getGlobal('focusName')).toBe('Hovered');
  });
});
