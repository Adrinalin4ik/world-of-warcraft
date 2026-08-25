/**
 * `SetFrameLevel`/`RaiseFrameLevel` carry the whole subtree.
 *
 * This is what stopped the character sheet's stat dropdowns opening.
 * `PlayerStatFrameLeftDropDown_OnLoad`'s first statement is `RaiseFrameLevel(self)`
 * (`paperdollframe.lua:1518`) on the CONTAINER whose child `$parentButton` owns the only `<OnClick>`
 * that opens the menu, and the container declares `enableMouse="true"` itself
 * (`paperdollframe.xml:726`). Raising only the frame left the container at its own button's level with
 * a fresher `linkStamp`, so `hitTest`'s backwards walk answered the container and the arrow's
 * `OnClick` never ran. The engine's levels are relative -- `Widget#add` builds them that way -- so
 * moving a parent must move its descendants.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { Widget, WidgetRoot } from '../../widget';

describe('frame level moves the subtree', () => {
  it('keeps a child above its parent after RaiseFrameLevel on the parent', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const ctx = installObjectModel(vm, registry, null);
    const rt = createFrameXmlRuntime(vm, ctx);
    const report = loadDocument(rt, parseXml(`
      <Ui>
        <Frame name="Holder" enableMouse="true">
          <Size><AbsDimension x="100" y="40"/></Size>
          <Frames>
            <Button name="HolderButton"><Size><AbsDimension x="24" y="24"/></Size></Button>
          </Frames>
        </Frame>
      </Ui>
    `), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);

    const widget = (n: string) => registry.widget(registry.byName(n)!) as Widget;
    const before = widget('HolderButton').frameLevel - widget('Holder').frameLevel;
    expect(before).toBe(1);

    expect(vm.run('Holder:SetFrameLevel(Holder:GetFrameLevel() + 5)', 't')).toBeNull();
    // The OFFSET is what matters: the child must still outrank the parent, or the parent wins the
    // hit test and swallows its own button's click.
    expect(widget('HolderButton').frameLevel - widget('Holder').frameLevel).toBe(1);

    // The client reaches this through FrameXML's own `RaiseFrameLevel(frame)` global
    // (`uiparent.lua:2216`), which is a wrapper over the method -- so the method is the thing to pin.
    expect(vm.run('Holder:RaiseFrameLevel()', 't')).toBeNull();
    expect(widget('HolderButton').frameLevel - widget('Holder').frameLevel).toBe(1);
  });
});
