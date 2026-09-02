import { LuaVM, LuaRef } from '../ui/framexml/lua/vm';
import { spellData } from '../pipeline/dbc/spell-data';
import { warnOnce } from '../ui/framexml/lua/methods/region';

/**
 * THE MISSILE MOTION SCRIPTS -- `SpellMissileMotion.dbc`'s flight laws, which are authored as LUA
 * SOURCE rather than as coefficients, evaluated per missile per frame.
 *
 * `world/spell-missile.ts` flies the reference's straight arrive-on-time line; this file is the
 * lateral offset that turns it into the arc the game actually authored. The reference has NOTHING
 * here -- `SpellMissileMotion` appears nowhere in benilla and `missile.rs:59-61` admits "a lobbed shot
 * reads as a straight glide here" -- so every decision below is measured off the served file and is
 * labelled as such.
 *
 * ## THE MEASUREMENT CAME FIRST, and it is what allows this to exist
 *
 * A per-missile per-frame VM evaluation sits squarely in the hazard `CLAUDE.md` records (a 10.1 s
 * interface freeze from fengari's `luaL_ref`/`luaL_unref` being O(live handles)), so it was measured
 * before it was written. `__bench__/motion-bench.test.ts` is the instrument; each figure is the median
 * of 9 runs after 3 warm-ups, on the real row-13 source.
 *
 * **THE NOISE FLOOR FIRST, and it is large.** Two full runs of the same bench on the same machine
 * differed by up to 2.3x on the smaller arms, and several arms report a spread WIDER than their own
 * median -- so the point values below are indications, not measurements to three decimals, and the
 * per-arm spread is quoted so nobody reads them as precise:
 *
 *     NOISE FLOOR   32 x the same parabola in pure JS            0.0018 ms  (spread 0.0019)
 *     naive         compile + call per evaluation, 32 missiles   4.1695 ms  (spread 3.4783)
 *     SHIPPED       compile once, call + 2 global reads,  1      0.0355 ms  (spread 0.0795)
 *     SHIPPED                                             8      0.2218 ms  (spread 0.0994)
 *     SHIPPED                                            32      0.4248 ms  (spread 0.4277)
 *     SHIPPED       ... reading all 6 vector outputs,     32      0.5182 ms  (spread 0.8378)
 *     row 19        Spiral Vortex (sin+cos),             32      0.3080 ms  (spread 0.0640)
 *     row 20        Drunken Missiles (2 sin + 2 cos),    32      1.0774 ms  (spread 0.4285)
 *
 * The 1-missile arm is BELOW THE INSTRUMENT'S RESOLUTION -- its spread (0.0795) exceeds its median
 * (0.0355), and the first run put the same arm at 0.0140 -- so the honest reading is "too small to
 * measure here", not 0.035 ms. Across both runs the 8-missile arm spanned 0.096-0.222 ms and the
 * 32-missile arm 0.323-0.425 ms.
 *
 * **The decision is robust to that noise even though the numbers are not.** A 60 fps frame is
 * 16.67 ms. The worst figure any run produced for a realistic projectile count -- 1 for Fireball, 3
 * for Multi-Shot, 5 for Arcane Missiles -- is 0.222 ms at eight, which is **1.3% of a frame**; the
 * whole 32-missile arm stays under 0.43 ms (2.6%), and the single most expensive row in the table at
 * 32 concurrent projectiles is 1.08 ms (6.5%), reached by 15 of 9406 visuals. Every one of those fits
 * with room to spare, so no plausible reading of the spread changes the verdict.
 *
 * **Caching the COMPILE is what makes it fit, and this is the one comparison the noise cannot touch**:
 * compiling per call costs 4.17 ms at 32 missiles -- 25% of a frame -- against 0.42 ms cached. A ~10x
 * saving, an order of magnitude clear of the spread, and the single decision this file turns on.
 * `luaL_loadbuffer` is the expensive half, not `lua_pcall`.
 *
 * The fengari handle hazard does NOT apply on this path, and that was checked rather than assumed:
 * `vm.ts` states in its own docstring that handles index "our own table" and that
 * "`luaL_ref`/`luaL_unref` on `LUA_REGISTRYINDEX` are NOT used for handles". The per-frame call also
 * creates no ref at all -- the outputs come back through globals -- so nothing is allocated or freed
 * per evaluation.
 *
 * ## Sample-and-interpolate was measured and REJECTED, by number and by correctness
 *
 * Evaluating once at launch over 16 samples and interpolating per frame measured **0.0062 ms** for 32
 * missiles -- ~68x cheaper per frame than calling, and the one arm whose spread (0.0006) is genuinely
 * tight. It is still the wrong choice:
 *
 *  - it buys 0.42 ms at a load that is not a problem, while adding a **0.174 ms per-missile spike at
 *    launch**, which lands exactly when several projectiles spawn together;
 *  - and it is **not equivalent** for the 124 of 204 rows that read `time`. Row 20's
 *    `sin(rand1 * 1000 + time * 1000)` oscillates many times per flight, and 16 samples would alias it
 *    into a different curve. A cheaper number that draws the wrong arc is not a saving.
 *
 * ## A DEDICATED VM, and this is not tidiness
 *
 * The scripts write GLOBALS -- `transMag`, `transAngle` and eight more -- and the measurement found
 * rows that write things they arguably should not: five rows assign `progress` itself -- four of the
 * Triple Parabola family (721, 722, 2744, 2804), remapping the parameter into sub-arcs, plus 2104
 * `Boomerang (Return)`, which reverses it -- one assigns `missileIndex` (row 1825
 * Engineering - Rocket Turret), and row 1503 assigns **`speedscalar`** with a lower-case s, which is
 * an authoring typo for `speedScalar` and is passed through rather than corrected. Running that in the
 * FrameXML VM would drop those names into the interface's own global table. So this owns a VM of its
 * own, created on first use and never shared.
 *
 * ## The trig convention is UNRESOLVED, and is isolated rather than guessed
 *
 * Ten of the 204 rows call bare `sin`/`cos` as GLOBALS -- 70 `sin` and 34 `cos` calls between them --
 * and there are four `fmod` calls, none of them `math.`-qualified either. Which
 * unit they take is genuinely not settled by the evidence available here, and `CLAUDE.md`'s record --
 * every orientation defect on this project has been two conventions meeting, three for three -- is why
 * this says so instead of picking quietly:
 *
 *  - **For degrees:** row 20's argument is `rand1 * 1000 + time * 1000`, which over a one-second flight
 *    sweeps ~1000 units. In degrees that is ~2.8 cycles -- a wobble a player can see. In radians it is
 *    ~159 cycles, which is visual noise. Row 19 also names its own constant `degreesPerSec` and adds
 *    `* 360`, so the ANGLE outputs are certainly degrees.
 *  - **Against degrees:** the one FrameXML caller of bare `cos` in the served manifest,
 *    `GameTime.lua:219`, computes `cos(TWOPI * timer * rate)` with `TWOPI = PI * 2` (`:17`) and resets
 *    at `>= TWOPI` -- arithmetic that only produces its intended 1 -> 0 pulse in RADIANS. In degrees
 *    that flash would be nearly static.
 *
 * Degrees is taken here for the in-domain reason (the magnitude argument above), and the conflict is
 * contained three ways: this is a separate VM, so nothing here can change what `GameTime.lua` sees;
 * only **11.5% of visuals (121 of 1051 that name a motion row)** reach a row calling trig at all; and
 * the nine most-used rows -- Parabola with 255 visuals, Parabola (High) 64, Forward Spin + Parabola 61,
 * Parabola (Top Spin) 32, Parabola (Low) 31 and four more, 548 visuals between them -- use **no trig
 * whatsoever**. Fireball's arc is pure arithmetic and cannot be affected either way. The falsifier is a
 * wobble that is either invisibly fast or visibly slow, which is something the owner can see.
 */

/**
 * The engine input set, MEASURED across all 204 rows by stripping `--` comments, collecting local
 * declarations and assignment targets, and taking what is left as free reads. In descending row count:
 *
 *     progress 165 | time 124 | startDistance 93 | missileIndex 44 | rand1 43 | missileCount 32
 *     rand2 32 | distanceToFirePos 23 | rand3 21 | distanceToImpactPos 9 | totalDistance 7
 *     distanceFromImpactPos 1
 *
 * Order is load-bearing: it is the parameter order of the compiled wrapper, so `evaluate`'s argument
 * array must match it exactly.
 *
 * **Every one of these is either the flight parameter or a per-missile launch constant**, which is the
 * finding that makes each script a pure function of progress per missile -- and therefore makes the
 * rejected sample-and-interpolate option viable in principle rather than impossible.
 */
const INPUTS = [
  'progress', 'time', 'startDistance', 'missileIndex', 'missileCount',
  'rand1', 'rand2', 'rand3', 'distanceToFirePos', 'distanceToImpactPos',
  'distanceFromImpactPos', 'totalDistance',
] as const;

/**
 * The outputs, MEASURED the same way (globals assigned, by row count):
 *
 *     transMag 115 | transAngle 114 | transUp 66 | transRight 56 | transFront 53 | modelPitch 49
 *     speedScalar 33 | modelRoll 23 | modelYaw 22 | scale 18
 *
 * Only the first five are read back: they are the position offset, which is all `spell-missile.ts` can
 * apply today. `modelPitch`/`modelRoll`/`modelYaw`/`scale`/`speedScalar` are NOT read, and that is a
 * named gap rather than an oversight -- a projectile here is positioned and never rotated, so it has
 * no orientation to pitch, and the arrive-on-time mover derives its own speed from the deadline.
 */
const OUTPUTS = ['transMag', 'transAngle', 'transFront', 'transRight', 'transUp'] as const;

/** One evaluation's position offset, in the flight basis `spell-missile.ts` builds. */
export interface MotionOffset {
  /** Magnitude of the lateral offset, world units. */
  transMag: number;
  /** Angle of that offset around the flight axis. DEGREES -- see the header's unresolved note. */
  transAngle: number;
  transFront: number;
  transRight: number;
  transUp: number;
}

/** Inputs for one evaluation. Keys are the measured `INPUTS` set. */
export interface MotionInputs {
  progress: number;
  time: number;
  startDistance: number;
  missileIndex: number;
  missileCount: number;
  rand1: number;
  rand2: number;
  rand3: number;
  distanceToFirePos: number;
  distanceToImpactPos: number;
  distanceFromImpactPos: number;
  totalDistance: number;
}

/**
 * The trig and modulo globals the scripts call BARE. Degrees, for the reason and with the conflict the
 * header states. `fmod` is unit-free so it carries none of that doubt.
 */
const PRELUDE = [
  'sin = function(d) return math.sin(d * math.pi / 180) end',
  'cos = function(d) return math.cos(d * math.pi / 180) end',
  'fmod = math.fmod',
].join('\n');

/** Zeroed in the compiled prologue -- see `compile`. */
const ZERO_PROLOGUE = OUTPUTS.map((name) => `${name} = 0`).join('; ');

class SpellMotion {
  private vm: LuaVM | null = null;

  /**
   * Motion row id -> its compiled chunk, or `null` for a row that failed to compile or raised.
   *
   * A failure is CACHED as null on purpose: without it a malformed row would be recompiled every frame
   * for every missile, which is the 3.87 ms arm of the measurement turned into a permanent cost.
   */
  private compiled = new Map<number, LuaRef | null>();

  /** THE INSTRUMENT. Compiles are one-off; evaluations are per missile per frame. */
  public stats = {
    compiled: 0, compileFailed: 0, evaluated: 0, evalFailed: 0, noRow: 0,
  };

  private ensureVm(): LuaVM {
    if (this.vm === null) {
      this.vm = new LuaVM();
      const error = this.vm.run(PRELUDE, 'motion-prelude');
      if (error !== null) {
        warnOnce(`spell motion: prelude failed to load -- ${error.message}`);
      }
    }
    return this.vm;
  }

  /**
   * Compile one motion row into a callable chunk, once.
   *
   * The wrapper turns the DBC's bare statement list into a function of the measured input set, and
   * **zeroes every output first**. That prologue is not decoration: the outputs are GLOBALS, so
   * without it a row that writes only `transMag` would inherit the previous missile's `transUp`, and a
   * cast that changed motion rows would blend two laws. It lives inside the compiled chunk rather than
   * as JS `setGlobal` calls because it is then five Lua stores instead of five JS-to-Lua crossings per
   * evaluation.
   */
  private compile(motionId: number, source: string): LuaRef | null {
    const cached = this.compiled.get(motionId);
    if (cached !== undefined) {
      return cached;
    }
    const vm = this.ensureVm();
    const wrapped = `return function(${INPUTS.join(', ')})\n${ZERO_PROLOGUE}\n${source}\nend`;
    const result = vm.runExpr(wrapped, `motion-${motionId}`);
    if ('message' in result) {
      this.stats.compileFailed += 1;
      // NAMED, never silent: a row that will not compile means that spell flies straight for ever, and
      // the reason has to be visible once rather than inferred from a missing arc.
      warnOnce(`spell motion: row ${motionId} failed to compile -- ${result.message}`);
      this.compiled.set(motionId, null);
      return null;
    }
    this.stats.compiled += 1;
    this.compiled.set(motionId, result.value as LuaRef);
    return result.value as LuaRef;
  }

  /**
   * Evaluate a spell's motion for one missile at one instant, or null when it has no motion row.
   *
   * Null is the ordinary answer for most spells and is NOT a gap: only 1051 of 9406 visuals name a
   * motion row at all, and a missile without one flies the straight arrive-on-time line, which is the
   * reference's own behaviour.
   */
  evaluate(spellId: number, inputs: MotionInputs): MotionOffset | null {
    const row = spellData.missileMotionScript(spellId);
    if (row === null) {
      this.stats.noRow += 1;
      return null;
    }
    const fn = this.compile(row.id, row.script);
    if (fn === null) {
      return null;
    }
    const vm = this.ensureVm();
    const error = vm.call(fn, INPUTS.map((name) => inputs[name]));
    if (error !== null) {
      this.stats.evalFailed += 1;
      warnOnce(`spell motion: row ${row.id} (${row.name}) raised -- ${error.message}`);
      // Cached as unusable: a row that raises once raises every frame, and a warning plus a straight
      // line is a better outcome than a per-frame throw on the render path.
      this.compiled.set(row.id, null);
      return null;
    }
    this.stats.evaluated += 1;

    // The outputs come back through globals rather than through return values, which is why the
    // per-frame path allocates no Lua ref: `callReturning` yields exactly ONE value and the contract
    // has ten. Reading five measured 0.359 ms at 32 missiles against 0.557 for all six vector outputs,
    // so reading only what is applied is worth ~0.1 ms at that count -- inside the spread, and kept because
    // it is also less code, not because the saving is proven.
    const read = (name: string): number => {
      const value = vm.getGlobal(name);
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };
    return {
      transMag: read('transMag'),
      transAngle: read('transAngle'),
      transFront: read('transFront'),
      transRight: read('transRight'),
      transUp: read('transUp'),
    };
  }

  /**
   * Drop every compiled chunk. For a teardown, NOT for a worldport.
   *
   * The cache is session-scoped on purpose and nothing calls this per world: a motion row is a
   * property of the DBC, not of the map, so the compiled chunk for Parabola is as valid in the next
   * zone as in this one. Re-compiling on a worldport would pay the 4.17 ms arm again for nothing.
   */
  dispose(): void {
    if (this.vm !== null) {
      for (const ref of this.compiled.values()) {
        if (ref !== null) {
          this.vm.unref(ref);
        }
      }
    }
    this.compiled.clear();
  }
}

/** One per session. The VM inside is created on first use, so a session that casts nothing pays none. */
export const spellMotion = new SpellMotion();

export default spellMotion;
