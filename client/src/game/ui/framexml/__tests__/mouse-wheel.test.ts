/**
 * `OnMouseWheel`, which reached nothing: `ui/input.ts` had no wheel listener at all, so no frame in the
 * client could be scrolled by the wheel. A router gap, not a script one -- `scripts.ts:134` already
 * routed the handler and bound its `delta` parameter.
 *
 * The ancestor walk is the load-bearing part: `UIPanelScrollFrameTemplate` binds `<OnMouseWheel>` on the
 * SCROLL FRAME (`uipaneltemplates.xml:327-329`) while the pointer is over the scroll child's content, so
 * stopping at the hit widget would find nothing on almost every real wheel event.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { GlueInput } from '../../input';
import { WidgetRoot } from '../../widget';

describe('OnMouseWheel', () => {
  it('reaches an ancestor handler, with the engine sign convention', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const canvas = document.createElement('canvas');
    // jsdom gives a detached canvas a ZERO bounding rect, and `input.ts#toUnits` divides by its height
    // -- so every coordinate comes out Infinity and `hitTest` finds nothing. Stubbed to a real viewport.
    canvas.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 1024, height: 768, right: 1024, bottom: 768, x: 0, y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
    const input = new GlueInput(canvas);
    const ctx = installObjectModel(vm, registry, input);
    const rt = createFrameXmlRuntime(vm, ctx);

    const report = loadDocument(rt, parseXml(`
      <Ui>
        <Frame name="Outer" enableMouse="true" setAllPoints="true">
          <Scripts><OnMouseWheel>wheeled = (wheeled or 0) + 1; got = delta;</OnMouseWheel></Scripts>
          <Frames>
            <Button name="Inner">
              <Size><AbsDimension x="100" y="40"/></Size>
              <Anchors><Anchor point="TOPLEFT"/></Anchors>
            </Button>
          </Frames>
        </Frame>
      </Ui>
    `), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);

    input.setDrawList(root.drawList({ width: 1024, height: 768 }));

    /** What `input.ts#onWheel` receives. `deltaY > 0` is scrolling DOWN in the DOM. */
    const wheel = (deltaY: number) => {
      let prevented = false;
      // `stopped` is not fixture bookkeeping -- it IS a requirement. The camera's own wheel handler sits
      // on `document.body` (`controls.tsx:106,156`), an ancestor of this canvas, so an event the UI took
      // and did not stop reaches the camera too and the panel scrolls while the view zooms out. The
      // owner reported exactly that; `preventDefault` alone does not stop a bubble.
      let stopped = false;
      (input as unknown as { onWheel: (e: WheelEvent) => void }).onWheel({
        deltaY,
        clientX: 10,
        clientY: 10,
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { stopped = true; },
      } as unknown as WheelEvent);
      return prevented && stopped;
    };

    // The pointer is over `Inner`, which has no handler -- the walk must find `Outer`'s.
    expect(wheel(120)).toBe(true);
    expect(vm.getGlobal('wheeled')).toBe(1);
    // DOM down (+deltaY) is engine -1; the client's `if ( value > 0 )` branch means +1 scrolls up.
    expect(vm.getGlobal('got')).toBe(-1);

    expect(wheel(-120)).toBe(true);
    expect(vm.getGlobal('got')).toBe(1);
    expect(vm.getGlobal('wheeled')).toBe(2);
  });
});
