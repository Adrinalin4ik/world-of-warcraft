/**
 * @jest-environment jsdom
 */
/**
 * **WHAT DOES IT COST TO ENTER LUA?** -- the arm that attributes `actionButtonMs`.
 *
 * The owner's census, standing still with no panels open, 2157 frames:
 *
 *     editBoxMs 0.03 | buttonMs 0.14 | actionButtonMs 1.90 (actionButtons 8) | onUpdateMs 1.63
 *
 * **1.90 ms across EIGHT buttons is 237 us to service one button per frame**, and the Lua that runs
 * is nothing like 237 us of work. `ActionButton_OnUpdate`
 * (`interface/framexml/actionbutton.lua:437-489`, fetched from the asset host) does, on a frame
 * where neither timer is due: one `ActionButton_IsFlashing` call, one table read, one subtraction,
 * one table write. So the cost is the CALL and not the body -- and this bench splits the two rather
 * than assuming it.
 *
 * **THIS IS THE RIGHT LAYER FOR THIS QUESTION, and that is worth stating** because it is usually the
 * wrong one. `CLAUDE.md` restricts the headless harness to "does a document load, a template expand,
 * a script bind" and forbids generalising it past a packet, a descriptor or a bridge. The cost of a
 * `LuaVM` call touches none of those: it is a `lua_pcall` plus argument marshalling inside fengari,
 * with no game state on either side. The absolute microseconds are this machine's, so what is
 * reported is the RATIO between arms measured in the same run -- which is the part that transfers.
 *
 * Deliberately not assertion-heavy: it prints, and asserts only the one thing that is a defect
 * rather than a measurement -- whether the invocation path leaks a registry handle.
 */
import { GlueInput } from '../../input';
import { WidgetRoot } from '../../widget';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { getScriptHandler, invokeScriptHandler, setScriptHandler } from '../lua/scripts';
import { LuaVM } from '../lua/vm';

function harness() {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const input = new GlueInput(document.createElement('canvas'));
  const ctx = installObjectModel(vm, registry, input);
  return { vm, registry, ctx };
}

/**
 * Mean over `n` iterations, in microseconds. Accumulate-and-divide, never a median: this clock is
 * quantised and the median of a quantised sample reads back only the quantum. That mistake cost an
 * earlier round its `gatherUs` arm, which read exactly 0 or 100.
 */
function meanUs(n: number, body: () => void): number {
  const t0 = performance.now();
  for (let i = 0; i < n; i += 1) {
    body();
  }
  return ((performance.now() - t0) * 1000) / n;
}

const N = 20000;

describe('cost of entering Lua', () => {
  it('splits the invocation machinery from the handler body', () => {
    const { vm, registry, ctx } = harness();

    // A real frame with a real wrapper, so `ctx.wrapper(self)` does what it does in the tick.
    const self = registry.create('Frame', 'BenchButton', null);

    // ARM A: an EMPTY handler. Everything measured is machinery.
    const empty = vm.runExpr('return function(self, elapsed) end', '=bench-empty');
    if ('value' in empty) {
      setScriptHandler(vm, self, 'OnUpdate', empty.value as never);
    }

    // Warm up, so V8's tier-up is not what is being measured instead of fengari.
    meanUs(2000, () => invokeScriptHandler(ctx, self, 'OnUpdate', [0.016]));
    const viaInvoke = meanUs(N, () => invokeScriptHandler(ctx, self, 'OnUpdate', [0.016]));

    // ARM B: the SAME handler through `vm.call` directly -- no `this`/`event`/`argN` save-restore and
    // no handler-store lookup. A minus B is `callWithBothConventions` and nothing else.
    const handler = getScriptHandler(vm, self, 'OnUpdate')!;
    const wrapper = ctx.wrapper(self);
    meanUs(2000, () => vm.call(handler, [wrapper, 0.016]));
    const viaCall = meanUs(N, () => vm.call(handler, [wrapper, 0.016]));

    // ARM C: a body shaped like the real `ActionButton_OnUpdate` non-due path -- a nested Lua call, a
    // field read, an arithmetic op, a field write. This is what the client actually runs per frame,
    // and note there is NO early return available: `self.rangeTimer` is set to -1 for every filled
    // button (`actionbutton.lua:248`), so the timer branch is always entered.
    vm.run(
      'BenchSelf = { flashing = 0, rangeTimer = 0.2, flashtime = 0 }\n'
      + 'function BenchIsFlashing(s) return s.flashing == 1 end\n',
      '=bench-setup',
    );
    const real = vm.runExpr(
      'return function(self, elapsed)\n'
      + '  local s = BenchSelf\n'
      + '  if BenchIsFlashing(s) then s.flashtime = s.flashtime - elapsed end\n'
      + '  local t = s.rangeTimer\n'
      + '  if t then t = t - elapsed if t <= 0 then t = 0.2 end s.rangeTimer = t end\n'
      + 'end',
      '=bench-real',
    );
    if ('value' in real) {
      setScriptHandler(vm, self, 'OnUpdate', real.value as never);
    }
    meanUs(2000, () => invokeScriptHandler(ctx, self, 'OnUpdate', [0.016]));
    const viaInvokeReal = meanUs(N, () => invokeScriptHandler(ctx, self, 'OnUpdate', [0.016]));

    const machinery = viaInvoke - viaCall;
    const body = viaInvokeReal - viaInvoke;

    // eslint-disable-next-line no-console
    console.log(
      `[lua-call] invoke(empty) ${viaInvoke.toFixed(2)} us`
      + ` | vm.call(empty) ${viaCall.toFixed(2)} us`
      + ` | invoke(real body) ${viaInvokeReal.toFixed(2)} us\n`
      + `           both-conventions machinery ${machinery.toFixed(2)} us`
      + ` = ${((machinery / viaInvokeReal) * 100).toFixed(0)}% of a real call`
      + ` | handler body ${body.toFixed(2)} us`
      + ` = ${((body / viaInvokeReal) * 100).toFixed(0)}%\n`
      + `           8 buttons/frame at invoke(real) = `
      + `${((viaInvokeReal * 8) / 1000).toFixed(3)} ms`
      + ` (owner measured actionButtonMs 1.90 ms over 8 = 237 us each)`,
    );

    expect(viaInvoke).toBeGreaterThan(0);
  });

  /**
   * **THE DEFECT, and this one is asserted rather than printed.**
   *
   * `callWithBothConventions` (`lua/scripts.ts:327-343`) saves the previous `this`, `event` and
   * `argN` with `vm.getGlobal` and restores them in a `finally`. `getGlobal` goes through `toJs`,
   * whose default branch mints a REGISTRY HANDLE for anything with no JS shape -- a table or a
   * function (`lua/vm.ts#toJs`). `scripts.ts` contains **no `unref` call on those saved values at
   * all**, so every save of a table-valued `this` allocates a slot that is never given back.
   *
   * A NESTED invocation is where `this` is table-valued: the outer handler has set it to its own
   * wrapper, so the inner one's save reads a table. That is the ordinary case rather than an exotic
   * one -- the tick's `OnUpdate` handlers call client functions that fire other frames' handlers.
   *
   * `ctx.wrapper(id)` is NOT the leak and was checked rather than assumed: it hands back the frame's
   * permanent handle and mints nothing (`lua/object.ts:461`).
   *
   * This is a leak whether or not it is today's hot line, and `LuaVM#liveHandles` is what makes it
   * visible. The count is the assertion: a fixed number of invocations must not grow it without
   * bound. A leak also has a SIGNATURE the owner's samples can be read against -- a cost that grows
   * with session length rather than with what is on screen -- which is why the count is censused too.
   */
  it('does not leak a Lua handle per handler invocation with a table in `this`', () => {
    const { vm, registry, ctx } = harness();
    const outerId = registry.create('Frame', 'BenchOuter', null);
    const innerId = registry.create('Frame', 'BenchInner', null);

    const inner = vm.runExpr('return function(self, elapsed) end', '=bench-inner');
    if ('value' in inner) {
      setScriptHandler(vm, innerId, 'OnUpdate', inner.value as never);
    }

    // Put a TABLE in `this`, which is exactly what an outer handler leaves there while an inner one
    // runs. Reproduced directly rather than through a real nested call, so the arm isolates the save.
    vm.setGlobal('this', ctx.wrapper(outerId));

    // Settle any one-off first-call allocation, then measure the steady state.
    for (let i = 0; i < 50; i += 1) {
      invokeScriptHandler(ctx, innerId, 'OnUpdate', [0.016]);
    }
    const before = vm.liveHandles;
    for (let i = 0; i < 500; i += 1) {
      invokeScriptHandler(ctx, innerId, 'OnUpdate', [0.016]);
    }
    const leaked = vm.liveHandles - before;

    // eslint-disable-next-line no-console
    console.log(
      `[lua-call] live handles ${before} -> ${vm.liveHandles}`
      + ` over 500 invocations with a table in \`this\``
      + ` = ${leaked} leaked (${(leaked / 500).toFixed(2)} per call)`,
    );

    expect(leaked).toBe(0);
  });
});
