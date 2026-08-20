/**
 * The input bridge: an XML-loaded frame's `<Scripts>` reached from the input router.
 *
 * Two happy-path tests and no more, by the project owner's standing budget, spent on the two halves the
 * whole layer turns on -- the pointer path (`SetScript` -> `Widget#onClick`) and the edit-box keyboard
 * path (a keystroke -> `OnTextChanged`/`OnTabPressed`/`OnEnterPressed`). Everything else about this
 * change is verified in a real browser against the client's own `AccountLogin.xml`, which is where a
 * defect in it would actually show up.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { GlueInput } from '../../input';
import { Widget, WidgetRoot } from '../../widget';

const noFiles = () => null;

/** A runtime whose object model carries a real focus router, as `framexml/runtime.ts` builds one. */
function runtime() {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const input = new GlueInput(document.createElement('canvas'));
  const ctx = installObjectModel(vm, registry, input);
  return { vm, registry, input, rt: createFrameXmlRuntime(vm, ctx) };
}

/** The router's key handling, driven directly -- same shape as `ui/__tests__/input.test.ts`. */
function pressKey(input: GlueInput, key: string): void {
  const event = {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;
  (input as unknown as { onKeyDown: (event: KeyboardEvent) => void }).onKeyDown(event);
}

describe('the FrameXML input bridge', () => {
  it('routes a pointer click on an XML-declared <Button> to its <OnClick>, with the button name', () => {
    const { vm, registry, rt } = runtime();

    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <Button name="Go">
            <Size><AbsDimension x="100" y="40"/></Size>
            <Scripts>
              <OnClick>
                clicked = (clicked or 0) + 1;
                clickedWith = arg1;
              </OnClick>
            </Scripts>
          </Button>
        </Ui>
      `),
      noFiles,
      'inline.xml',
    );

    expect(report.errors).toEqual([]);
    const widget = registry.widget(registry.byName('Go')!) as Widget;
    // Mouse-enabled BY CLASS: the element declares no `enableMouse`, and neither does any button on the
    // client's login screen.
    expect(widget.mouseEnabled).toBe(true);

    // What `input.ts` does on a completed click, at the one boundary the bridge owns.
    widget.onClick!('LeftButton');

    expect(vm.getGlobal('clicked')).toBe(1);
    expect(vm.getGlobal('clickedWith')).toBe('LeftButton');
  });

  it('routes typing, Tab and Enter on an XML-declared <EditBox> to its keyboard handlers', () => {
    const { vm, registry, input, rt } = runtime();

    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <EditBox name="Box" letters="32">
            <Size><AbsDimension x="200" y="32"/></Size>
            <Scripts>
              <OnTextChanged>
                changed = (changed or 0) + 1;
                changedTo = self:GetText();
              </OnTextChanged>
              <OnTabPressed>
                tabbed = true;
              </OnTabPressed>
              <OnEnterPressed>
                submitted = self:GetText();
              </OnEnterPressed>
            </Scripts>
            <FontString/>
          </EditBox>
        </Ui>
      `),
      noFiles,
      'inline.xml',
    );

    expect(report.errors).toEqual([]);
    const box = registry.widget(registry.byName('Box')!) as Widget;
    // Focusable by class too, which is what lets a pointer click land focus on it.
    expect(box.focusable).toBe(true);

    input.setFocus(box);
    pressKey(input, 'a');
    pressKey(input, 'b');

    expect(box.text).toBe('ab');
    expect(vm.getGlobal('changed')).toBe(2);
    expect(vm.getGlobal('changedTo')).toBe('ab');

    // Tab reaches the document's own handler rather than the router's draw-order ring.
    pressKey(input, 'Tab');
    expect(vm.getGlobal('tabbed')).toBe(true);
    expect(input.focused).toBe(box);

    pressKey(input, 'Enter');
    expect(vm.getGlobal('submitted')).toBe('ab');
  });
});
