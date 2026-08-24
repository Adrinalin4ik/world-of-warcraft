import { LuaVM } from '../framexml/lua/vm';
import { FrameRegistry, installObjectModel } from '../framexml/lua/object';
import { WidgetRoot } from '../widget';
import { attachMapBridge } from '../map-bridge';
import type World from '../../world';
// Side-effect imports: the REGION and FRAME method tables. `loader.ts` pulls these in for the real
// runtime; a bare harness gets none of them, so `SetAlpha` would be nil for a reason that has nothing to
// do with what this test is about.
import '../framexml/lua/methods/region';
import '../framexml/lua/methods/frame';

/**
 * ONE test, and it exists because I got this frame wrong TWICE.
 *
 * `WorldMapFrame_OnLoad` calls `CreateWorldMapArrowFrame(WorldMapFrame)` and indexes
 * `PlayerArrowEffectFrame` eleven lines later, so a miss kills the rest of that function -- the map's
 * scale, its frame levels, the objective text's line height. The first attempt no-oped the global; the
 * second created the frame in the registry but never minted its Lua table, and **the registry's name map
 * is not Lua's global table**, so the frame existed and the global was still nil.
 *
 * This is exactly the layer the headless harness is authoritative for, per `CLAUDE.md`: does a global
 * exist, does a frame materialise. No packets, no world, no descriptor -- and none needed, because the
 * question is only whether `_G.PlayerArrowEffectFrame` is there after the engine call.
 */
function harness() {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry);
  // The bridge reads `world.player` and `world.map` through optional chains and answers empty when they
  // are absent, which is what a stub gives it. Nothing in this test touches either.
  const world = { player: null, map: null } as unknown as World;
  const bridge = attachMapBridge(vm, world, ctx);
  return { vm, bridge };
}

test('CreateWorldMapArrowFrame publishes PlayerArrowEffectFrame as a Lua global', () => {
  const { vm, bridge } = harness();
  try {
    // Nothing has created it yet, which is the state `WorldMapFrame_OnLoad` starts from.
    expect(vm.runExpr('return PlayerArrowEffectFrame ~= nil', 'before')).toEqual({ value: false });

    // The client's own call, with a real frame as the parent.
    expect(vm.run(
      'local parent = CreateFrame("Frame", "WorldMapFrameStub", nil)\n'
      + 'CreateWorldMapArrowFrame(parent)',
      'create',
    )).toBeNull();

    expect(vm.runExpr('return PlayerArrowEffectFrame ~= nil', 'after')).toEqual({ value: true });

    // And it answers the only two methods the client ever calls on it (all five uses, grepped).
    expect(vm.run(
      'PlayerArrowEffectFrame:SetAlpha(0.65); PlayerArrowEffectFrame:SetFrameLevel(140)',
      'use',
    )).toBeNull();
  } finally {
    bridge.dispose();
  }
});
