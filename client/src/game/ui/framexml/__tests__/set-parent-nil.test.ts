import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { WidgetRoot } from '../../widget';
import type { Viewport } from '../../layout';
import '../lua/methods/region';
import '../lua/methods/frame';

/**
 * `SetParent(nil)` KEEPS THE FRAME ON SCREEN, and it used to drop it out of the world.
 *
 * `WorldMap_ToggleSizeUp`'s second statement is `WorldMapFrame:SetParent(nil)`
 * (`worldmapframe.lua:1313`) -- the one call site in the whole decoded manifest, and it is the map's
 * full-screen mode. Our `SetParent` detached instead of re-homing, so the map left the draw walk: it
 * vanished and could not be reopened, **with no error at all**, because nothing had failed.
 *
 * A parentless frame in the real client is a TOP-LEVEL frame -- still drawn, no longer inheriting
 * `UIParent`'s scale or joining the UI-panel layout, which is exactly why the client uses it here.
 *
 * The assertion is the SYMPTOM and not the implementation: the widget must still have a rect in the
 * layout walk. Checking `widget.parent === root` would pass on a detach that the draw pass still skipped.
 */
const VIEWPORT: Viewport = { width: 1024, height: 768 };

test('SetParent(nil) re-homes to the screen and GetParent then answers nil', () => {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  installObjectModel(vm, registry);

  expect(vm.run(
    'Holder = CreateFrame("Frame", "Holder", nil)\n'
    + 'Panel = CreateFrame("Frame", "Panel", Holder)\n'
    + 'Panel:SetWidth(200); Panel:SetHeight(100); Panel:SetPoint("CENTER")',
    'build',
  )).toBeNull();

  const id = registry.byName('Panel')!;
  const widget = registry.widget(id)!;
  expect(root.layoutRects(VIEWPORT).has(widget.id)).toBe(true);

  expect(vm.run('Panel:SetParent(nil)', 'detach')).toBeNull();

  // STILL LAID OUT -- the half that was broken, and the half a screenshot showed as "the map vanished".
  expect(root.layoutRects(VIEWPORT).has(widget.id)).toBe(true);

  // And parentless as far as Lua is concerned, which is the engine's answer too: the screen root is not
  // a frame, so `Registry#parentOf` finds no id for it.
  expect(vm.runExpr('return Panel:GetParent() == nil', 'parent')).toEqual({ value: true });
});
