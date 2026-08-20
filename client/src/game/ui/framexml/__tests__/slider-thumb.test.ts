/**
 * A `<Slider>`'s `<ThumbTexture>`, and `SetValue` firing `OnValueChanged`.
 *
 * Two wholesale gaps behind "скролла у нас нет", both affecting EVERY scroll frame in the client and
 * not just the Skills tab:
 *  - `<ThumbTexture>` was read by nothing (`loader.ts`'s state-texture list stops at Checked), so no
 *    scrollbar anywhere had a visible thumb. Two of the six in the manifest are in
 *    `uipaneltemplates.xml`, which every scroll frame inherits.
 *  - `Slider:SetValue` fired no `OnValueChanged`, and the arrow buttons do nothing but
 *    `SetValue(GetValue() -/+ GetValueStep())`. So an arrow click moved a number and nothing
 *    re-rendered the list.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { Widget, WidgetRoot } from '../../widget';

function load(xml: string) {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry, null);
  const rt = createFrameXmlRuntime(vm, ctx);
  const report = loadDocument(rt, parseXml(xml), () => null, 'inline.xml');
  return { vm, root, registry, report };
}

describe('Slider', () => {
  it('creates a thumb region from <ThumbTexture> and sizes it from the element', () => {
    const { root, report } = load(`
      <Ui>
        <Slider name="Bar" minValue="0" maxValue="100">
          <Size><AbsDimension x="16" y="200"/></Size>
          <ThumbTexture name="$parentThumbTexture" file="Interface\Buttons\UI-ScrollBar-Knob">
            <Size><AbsDimension x="16" y="24"/></Size>
          </ThumbTexture>
        </Slider>
      </Ui>
    `);
    expect(report.errors).toEqual([]);

    // The thumb is a real drawable region owned by the slider, with the file and size the XML gave it.
    const thumbs: Widget[] = [];
    const walk = (w: Widget): void => {
      if (w.kind === 'texture' && w.sprite !== null) {
        thumbs.push(w);
      }
      w.children.forEach(walk);
    };
    walk(root.root);
    expect(thumbs.length).toBe(1);
    expect(thumbs[0].sprite).toContain('UI-ScrollBar-Knob');
    expect(thumbs[0].height).toBe(24);
  });

  it('fires OnValueChanged on a real change, and not on an unchanged write', () => {
    const { vm, report } = load(`
      <Ui>
        <Slider name="Scroller">
          <Size><AbsDimension x="16" y="200"/></Size>
          <Scripts>
            <OnValueChanged>
              fired = (fired or 0) + 1;
              lastValue = value;
            </OnValueChanged>
          </Scripts>
        </Slider>
      </Ui>
    `);
    expect(report.errors).toEqual([]);

    expect(vm.run('Scroller:SetMinMaxValues(0, 100); Scroller:SetValue(40)', 't')).toBeNull();
    expect(vm.getGlobal('fired')).toBe(1);
    // `value` is a NAMED parameter -- `scripts.ts:135` binds it, which is what the old "we cannot
    // dispatch this" note in `methods/scroll.ts` had stopped being true about.
    expect(vm.getGlobal('lastValue')).toBe(40);

    // The arrow handlers push past an end and read back, so an unchanged write must not re-fire.
    expect(vm.run('Scroller:SetValue(40)', 't')).toBeNull();
    expect(vm.getGlobal('fired')).toBe(1);
  });
});
