/**
 * ONE happy-path test, and it is the client's own arithmetic rather than the setter in isolation.
 *
 * `Minimap_ZoomInClick` is `SetZoom(GetZoom() + 1)` and only then checks whether it landed on the top
 * level (`minimap.lua:158-165`), so what has to hold is the ROUND TRIP: the value moves, and it stops.
 * Asserting `SetZoom(2)` then `GetZoom() == 2` would pass on a setter that never clamped, which is the
 * half that would leave `MinimapZoomIn` enabled at the top for ever.
 *
 * The load report is asserted too, because the reason this table exists is that
 * `Minimap:SetPlayerTextureHeight(40)` in `MinimapPing_OnLoad` was throwing during document load.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';
// Side-effect import: registers the MINIMAP method table under test.
import '../lua/methods/minimap';

test('the minimap zoom moves under the client\'s own increment and stops at both ends', () => {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry);
  const rt = createFrameXmlRuntime(vm, ctx);

  const report = loadDocument(
    rt,
    parseXml('<Ui><Minimap name="Minimap"/></Ui>'),
    () => null,
    'minimap.test',
  );
  expect(report.errors).toEqual([]);

  // The two calls that were throwing out of `MinimapPing_OnLoad` before this table existed.
  expect(vm.run('Minimap:SetPlayerTextureHeight(40); Minimap:SetPlayerTextureWidth(40)', 'arrow'))
    .toBeNull();

  // Climb with the client's own expression, one level past the top. `GetZoomLevels() - 1` is where
  // `Minimap_ZoomInClick` expects to stop, so that is what the walk must land on.
  expect(vm.run(
    'for _ = 1, Minimap:GetZoomLevels() + 3 do Minimap:SetZoom(Minimap:GetZoom() + 1) end\n'
    + 'assert(Minimap:GetZoom() == Minimap:GetZoomLevels() - 1)',
    'zoom in',
  )).toBeNull();

  // And down past the bottom, where `Minimap_ZoomOutClick` compares against a literal 0.
  expect(vm.run(
    'for _ = 1, Minimap:GetZoomLevels() + 3 do Minimap:SetZoom(Minimap:GetZoom() - 1) end\n'
    + 'assert(Minimap:GetZoom() == 0)',
    'zoom out',
  )).toBeNull();
});
