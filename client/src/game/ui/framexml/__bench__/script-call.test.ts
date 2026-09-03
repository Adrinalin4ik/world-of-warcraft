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

  /**
   * **DOES THE PRICE OF A CALL DEPEND ON HOW BIG THE VM IS?** -- the arm that tests whether the
   * harness can explain the live number at all.
   *
   * The owner's live VM stands at **39,499 handles** (flat, so not a leak) with the whole of
   * `FrameXML.toc` loaded and a globals table to match. The harness's VM has about five handles and
   * a bare global environment, and prices an invocation at ~23 us against a live ~239 us. If any
   * part of `callWithBothConventions` is linear -- or even weakly superlinear -- in the live
   * population, that is the 10x, and it is testable here by building the population first.
   *
   * The suspects are named rather than swept for: `lua_getglobal`/`lua_setglobal` hash into the
   * globals table (nine round-trips per call), and `ref`/`unref` index our own slots table, which is
   * a fengari `Table` backed by a JS `Map`. The record says handle operations were once
   * O(live handles) under `luaL_ref` and were moved off it precisely for that reason
   * (`lua/vm.ts#ref`, a measured 0.65 us -> 151 us across 0 -> 20,000 handles), so a residual
   * linearity here is a specific, historically-grounded worry rather than a guess.
   *
   * Prints a cost-versus-population curve. Flat means the harness cannot explain the live figure and
   * the gap is elsewhere -- his CPU, or the bundle -- which is a real answer and closes a line of
   * enquiry. Rising means it is found.
   */
  it('prices an invocation against the live VM population', () => {
    const { vm, registry, ctx } = harness();
    const self = registry.create('Frame', 'BenchScale', null);

    const real = vm.runExpr(
      'return function(self, elapsed) \n'
      + '  local t = self \n'
      + '  if t then local x = elapsed + 1 end \n'
      + 'end',
      '=bench-scale',
    );
    if ('value' in real) {
      setScriptHandler(vm, self, 'OnUpdate', real.value as never);
    }

    // A globals table the size of a loaded manifest's, so `lua_getglobal` hashes into a realistic
    // one. `FrameXML.toc` defines thousands of functions and frame names.
    vm.run(
      'for i = 1, 6000 do _G["BenchGlobal" .. i] = { slot = i } end',
      '=bench-globals',
    );

    const held: unknown[] = [];
    const curve: string[] = [];

    for (const target of [0, 10000, 40000]) {
      // Grow the LIVE handle population by holding refs, exactly as the running interface does.
      while (vm.liveHandles < target) {
        const got = vm.getGlobal(`BenchGlobal${(held.length % 6000) + 1}`);
        held.push(got);
      }
      meanUs(2000, () => invokeScriptHandler(ctx, self, 'OnUpdate', [0.016]));
      const us = meanUs(N, () => invokeScriptHandler(ctx, self, 'OnUpdate', [0.016]));
      curve.push(`${vm.liveHandles} handles -> ${us.toFixed(2)} us`);
    }

    // eslint-disable-next-line no-console
    console.log(
      '[lua-call] invoke cost vs live handle population:\n'
      + curve.map((row) => `           ${row}`).join('\n'),
    );

    expect(curve).toHaveLength(3);
  });


  /**
   * **DOES THE PRICE OF A CALL DEPEND ON HOW MANY GLOBALS EXIST?** -- and this is the arm that found
   * the 10x.
   *
   * It was not looked for. The population arm above prices an invocation at ~97 us while the very
   * first arm prices a STRICTLER body at ~22 us, and the only material difference between the two
   * VMs is that the population arm had already defined 6000 globals so that `lua_getglobal` would
   * hash into a realistic table. That is a 4x on an accident, which makes it the most interesting
   * number in the file and worth an arm that isolates it instead of inferring it.
   *
   * The mechanism, if it is real: `callWithBothConventions` does **nine** `lua_getglobal` /
   * `lua_setglobal` round-trips per invocation (`this`, `event` and `arg1` each saved, set and
   * restored). The globals table is a fengari `Table`, and a `Table` that has grown a large hash
   * part is not the O(1) a JS `Map` would suggest -- the same class of finding as `luaL_ref` being
   * O(live handles) here, which is already recorded in `lua/vm.ts#ref`.
   *
   * WHY IT WOULD EXPLAIN THE LIVE NUMBER: `FrameXML.toc` defines thousands of globals -- every
   * client function, every frame name, every constant. The harness's bare environment has a few
   * dozen. So this is a cost the harness structurally under-reports, which is exactly the shape of a
   * 10x gap that survived a correct per-call measurement.
   *
   * Same handler and same VM throughout, growing only the globals table between readings, so the
   * body and the handle population are held constant and the globals are the only variable.
   */
  it('prices an invocation against the size of the globals table', () => {
    const { vm, registry, ctx } = harness();
    const self = registry.create('Frame', 'BenchGlobals', null);

    const real = vm.runExpr(
      'return function(self, elapsed) local x = elapsed + 1 end',
      '=bench-globals-scale',
    );
    if ('value' in real) {
      setScriptHandler(vm, self, 'OnUpdate', real.value as never);
    }

    const curve: string[] = [];
    let defined = 0;

    for (const target of [0, 2000, 6000, 12000]) {
      if (target > defined) {
        vm.run(
          `for i = ${defined + 1}, ${target} do _G["BenchG" .. i] = i end`,
          '=bench-grow',
        );
        defined = target;
      }
      meanUs(2000, () => invokeScriptHandler(ctx, self, 'OnUpdate', [0.016]));
      const us = meanUs(N, () => invokeScriptHandler(ctx, self, 'OnUpdate', [0.016]));
      curve.push(`${defined} globals -> ${us.toFixed(2)} us/invoke`);
    }

    // eslint-disable-next-line no-console
    console.log(
      '[lua-call] invoke cost vs globals-table size:\n'
      + curve.map((row) => `           ${row}`).join('\n'),
    );

    expect(curve).toHaveLength(4);
  });


  /**
   * **IS THE LINEAR TERM IN THE GLOBAL ROUND-TRIPS, OR IN THE ENVIRONMENT?** -- the arm that decides
   * whether a fix to the write path would buy anything at all.
   *
   * The previous arm grew `_G` and found cost linear in its size. But "grew `_G`" changes more than
   * the write path: a 12,000-entry `Map` changes GC pressure, allocation locality and the shape of
   * every hash the VM performs, so the linear term need not be in the nine round-trips at all.
   *
   * A mechanism was proposed for it -- that a nil write deletes the key and the next insert rehashes
   * the table -- and **it does not survive fengari's source.** `luaH_setfrom` (`ltable.js:209-212`)
   * calls `mark_dead` on a nil write, and `mark_dead` (`:141-162`) is one `Map.delete`, a
   * doubly-linked-list unlink and a `set` into `dead_strong`: **O(1), with no rehash anywhere.**
   * (`add` at `:118` does open with `t.dead_strong.clear()`, but `dead_strong` only holds entries
   * killed since the last insert, which in this path is at most three.) So the linearity is real and
   * that explanation of it was wrong.
   *
   * This arm holds `|_G|` FIXED at 12,000 and varies only how many round-trips an invocation makes:
   * 0 (a bare `vm.call`), 3 (set only), 9 (the real save-set-restore shape). Cost rising with
   * round-trips at fixed `|_G|` puts the multiplier in the write path and makes a fix there worth
   * building; cost flat across them puts it in the environment, and no amount of work on
   * `callWithBothConventions` would help.
   *
   * The per-round-trip cost is also measured directly at two table sizes, which is the same question
   * asked from the other side.
   */
  it('separates the round-trip count from the size of the environment', () => {
    const { vm, registry, ctx } = harness();
    const self = registry.create('Frame', 'BenchTrips', null);
    const handlerExpr = vm.runExpr(
      'return function(self, elapsed) local x = elapsed + 1 end',
      '=bench-trips',
    );
    setScriptHandler(vm, self, 'OnUpdate', (handlerExpr as { value: unknown }).value as never);
    const handler = getScriptHandler(vm, self, 'OnUpdate')!;
    const wrapper = ctx.wrapper(self);

    // ONE round-trip pair, priced on its own at a bare table and then a full one. If a single
    // get+set is size-independent, the nine cannot be carrying a linear term.
    const tripCostAt = (label: string): string => {
      meanUs(2000, () => {
        vm.setGlobal('benchProbe', 1);
        vm.getGlobal('benchProbe');
      });
      const pair = meanUs(N, () => {
        vm.setGlobal('benchProbe', 1);
        vm.getGlobal('benchProbe');
      });
      // The nil write is the one the refuted mechanism blamed, so it is priced separately.
      const nilWrite = meanUs(N, () => {
        vm.setGlobal('benchProbeNil', 1);
        vm.setGlobal('benchProbeNil', undefined);
      });
      return `${label}: get+set ${pair.toFixed(3)} us | set+nil-set ${nilWrite.toFixed(3)} us`;
    };

    const lines: string[] = [tripCostAt('bare _G')];

    vm.run('for i = 1, 12000 do _G["BenchT" .. i] = i end', '=bench-fill');
    lines.push(tripCostAt('12000 globals'));

    // Now the round-trip COUNT, at a fixed 12,000-entry `_G`.
    const trips0 = meanUs(N, () => vm.call(handler, [wrapper, 0.016]));
    const trips3 = meanUs(N, () => {
      vm.setGlobal('this', wrapper);
      vm.setGlobal('event', 0.016);
      vm.setGlobal('arg1', 0.016);
      vm.call(handler, [wrapper, 0.016]);
    });
    const trips9 = meanUs(N, () => invokeScriptHandler(ctx, self, 'OnUpdate', [0.016]));

    lines.push(`at fixed |_G| = 12000: 0 trips ${trips0.toFixed(2)} us`
      + ` | 3 trips ${trips3.toFixed(2)} us | 9 trips (real) ${trips9.toFixed(2)} us`);

    // eslint-disable-next-line no-console
    console.log('[lua-call] round-trips vs environment:\n' + lines.map((r) => `           ${r}`).join('\n'));

    expect(lines).toHaveLength(3);
  });


  /**
   * **IS "ONCE PER OUTERMOST INVOCATION" ANY CHEAPER THAN WHAT WE ALREADY DO?** -- the arm that
   * checks the arithmetic behind a proposed fix before the fix is built.
   *
   * The proposal was to keep the nil write but do it once per OUTERMOST invocation rather than once
   * per call, on the expectation that eight action buttons would then cost three deletes a frame
   * instead of twenty-four.
   *
   * **But today`s code already defers to the outermost invocation, and it does so for free.** The
   * restore writes back the SAVED value: a nested invocation saves the outer handler`s wrapper,
   * which is non-nil, so its restore is an OVERWRITE and never a delete. Only the outermost
   * invocation -- the one whose saved value is nil -- deletes. A depth counter would be gating a
   * case that is already gated.
   *
   * The eight buttons are not nested. They are eight SEQUENTIAL top-level invocations from the
   * tick`s own loop, each at depth 1, so each is outermost and each deletes. 8 x 3 = 24 deletes a
   * frame, and no depth counter can merge them, because there is no enclosing invocation to merge
   * them into.
   *
   * This arm proves it by timing the two shapes at a fixed 12,000-entry `_G`: eight sequential
   * top-level invocations against one invocation that nests seven. If nesting is already cheap per
   * invocation, the deferral exists and the proposed saving does not.
   */
  it('shows the nil write is already once per outermost invocation', () => {
    const { vm, registry, ctx } = harness();
    const outer = registry.create('Frame', 'BenchNestOuter', null);
    const inner = registry.create('Frame', 'BenchNestInner', null);

    const leaf = vm.runExpr(
      'return function(self, elapsed) local x = elapsed + 1 end',
      '=bench-leaf',
    );
    setScriptHandler(vm, inner, 'OnUpdate', (leaf as { value: unknown }).value as never);
    setScriptHandler(vm, outer, 'OnUpdate', (leaf as { value: unknown }).value as never);

    // A door back into the invocation path from Lua, so the nested shape is a REAL nested
    // `invokeScriptHandler` and not a simulation of one.
    vm.registerFunction('BenchFireInner', () => {
      invokeScriptHandler(ctx, inner, 'OnUpdate', [0.016]);
      return [];
    });
    const nester = vm.runExpr(
      'return function(self, elapsed) for i = 1, 7 do BenchFireInner() end end',
      '=bench-nester',
    );

    vm.run('for i = 1, 12000 do _G["BenchN" .. i] = i end', '=bench-fill-nest');

    // SHAPE A: eight sequential top-level invocations -- the tick`s action-button loop.
    const sequential = meanUs(2000, () => {
      for (let i = 0; i < 8; i += 1) {
        invokeScriptHandler(ctx, outer, 'OnUpdate', [0.016]);
      }
    });

    // SHAPE B: one top-level invocation that nests seven, for the same eight entries into Lua.
    setScriptHandler(vm, outer, 'OnUpdate', (nester as { value: unknown }).value as never);
    const nested = meanUs(2000, () => invokeScriptHandler(ctx, outer, 'OnUpdate', [0.016]));

    // eslint-disable-next-line no-console
    console.log(
      '[lua-call] eight entries into Lua at |_G| = 12000:\n'
      + `           8 sequential top-level: ${sequential.toFixed(1)} us`
      + ` (${(sequential / 8).toFixed(1)} us per invocation)\n`
      + `           1 top-level nesting 7:  ${nested.toFixed(1)} us`
      + ` (${(nested / 8).toFixed(1)} us per invocation)\n`
      + `           => nesting is ${(sequential / nested).toFixed(1)}x cheaper per entry,`
      + ' so the deferral to the outermost invocation ALREADY exists',
    );

    // The point of the arm: nesting is already dramatically cheaper, because only the outermost
    // invocation deletes. If this ever fails, the deferral has been lost and a depth counter WOULD
    // buy something.
    expect(nested).toBeLessThan(sequential);
  });

});
