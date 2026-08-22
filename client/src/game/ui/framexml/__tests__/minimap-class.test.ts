/**
 * `<Minimap>` IS A FRAME CLASS, and its absence killed the whole UI-panel layout.
 *
 * `parseClass` had no MINIMAP, so `CreateFrame("Minimap")` threw and the loader dropped the element and
 * its subtree -- the same defect family as COOLDOWN, GAMETOOLTIP and WORLDFRAME, and found the same way:
 * something asked for the global and got nil.
 *
 * What asked was `GetMaxUIPanelsWidth`, which indexes it unguarded (`uiparent.lua:2007`) inside the gate
 * the CENTER panel's placement sits behind. The raise landed after
 * `FramePositionDelegate:UpdateUIPanelPositions` set `self.updatingPanels = true` (`:1658`) and before
 * the line clearing it, so every later call returned at `:1656` and the layout stayed dead for the
 * session. Measured live, the owner's console:
 *
 *     ERR [string "UIParent.lua"]:2007: attempt to index a nil value (global 'Minimap')
 *
 * Asserting the client's own expression rather than "the global exists": what broke was the
 * index-then-call, and a test for non-nil would pass on a value that is not a frame.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';

describe('<Minimap>', () => {
  it('materializes as a frame the panel-layout gate can index', () => {
    const vm = new LuaVM();
    const root = new WidgetRoot();
    const registry = new FrameRegistry(root.root);
    const ctx = installObjectModel(vm, registry, null);
    const rt = createFrameXmlRuntime(vm, ctx);

    // `minimap.xml`'s own shape: the Minimap inside MinimapCluster.
    const report = loadDocument(rt, parseXml(`
      <Ui>
        <Frame name="MinimapCluster">
          <Size><AbsDimension x="200" y="200"/></Size>
          <Anchors><Anchor point="TOPRIGHT"/></Anchors>
          <Frames>
            <Minimap name="Minimap">
              <Size><AbsDimension x="140" y="140"/></Size>
              <Anchors><Anchor point="TOPLEFT"/></Anchors>
            </Minimap>
          </Frames>
        </Frame>
      </Ui>
    `), () => null, 'inline.xml');
    expect(report.errors).toEqual([]);

    // Verbatim `uiparent.lua:2007`, the line that raised.
    expect(vm.run(
      'gate = Minimap:IsShown() and not MinimapCluster:IsUserPlaced()',
      'gate',
    )).toBeNull();
    expect(vm.getGlobal('gate')).toBe(true);
  });
});
