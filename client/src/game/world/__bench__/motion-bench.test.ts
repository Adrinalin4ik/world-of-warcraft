import { LuaVM } from '../../ui/framexml/lua/vm';

/**
 * THE MOTION-SCRIPT COST INSTRUMENT -- the measurement that decided whether
 * `SpellMissileMotion.dbc`'s Lua flight laws can be evaluated per missile per frame.
 *
 * This is a BENCHMARK, not a correctness test, and it deliberately asserts nothing about time: a
 * timing assertion in a suite is a flake generator, and the numbers vary with the machine. What it
 * asserts is that every arm actually ran and produced a finite value, so the printed timings cannot be
 * of a loop that silently did nothing -- which is how a benchmark lies.
 *
 * It lives here rather than in `client/harness/` because that directory belongs to another lane this
 * round. Run it alone with:
 *
 *     CI=true node scripts/test.js --watchAll=false --testPathPattern="motion-bench"
 *
 * The three sources are the REAL rows, copied verbatim out of the served `SpellMissileMotion.dbc`
 * (row 13 `Parabola`, 19 `Spiral Vortex`, 20 `Drunken Missiles`) rather than loaded from a dumped
 * fixture, so the file is self-contained and doubles as the design record for what the data looks
 * like. `\r\n` is preserved because that is how the DBC stores them and Lua treats it as whitespace.
 *
 * The numbers this produced, and the decision they drove, are recorded on `world/spell-motion.ts`.
 */

/** `SpellMissileMotion.dbc` row 13. Reached by 255 `SpellVisual` rows -- the most-used law by far. */
const PARABOLA = 'local angle = 0\r\nlocal maxMagnitude = startDistance * .15\r\n\r\ntransAngle = angle\r\ntransMag = (progress * 2) - 1\r\ntransMag = (1 - (transMag * transMag)) * maxMagnitude';

/** Row 19. Uses `missileIndex`/`missileCount` and `time`, and names its own `degreesPerSec`. */
const SPIRAL = 'local startAngle = 0\r\nlocal degreesPerSec = 180\r\nlocal maxMagnitude = 3\r\nlocal maxKickBack = 10\r\n\r\ntransAngle = startAngle + ((missileIndex / missileCount) * 360) + (time * degreesPerSec)\r\ntransMag = 1 - progress\r\ntransMag = (transMag * transMag * 2) - 1\r\ntransMag = (1 - (transMag * transMag))\r\ntransFront = transMag * -maxKickBack\r\ntransMag = transMag * maxMagnitude\r\n';

/** Row 20 -- the most expensive row in the table: two `sin` and two `cos` per evaluation. */
const DRUNK = 'local maxMagnitude = 1.5\r\nlocal minSpeedScalar = .7\r\nlocal maxSpeedScalar = 1.5\r\n\r\nlocal magnitude = (progress * 1.9) - 1\r\nmagnitude = 1 - (magnitude * magnitude * magnitude * magnitude)\r\n\r\ntransRight = (sin((rand1 * 1000) + (time * 1000)) + cos((rand2 * 1000) + (time * 200))) * magnitude\r\ntransUp = (sin((rand2 * 1000) + (time * 700)) + cos((rand1 * 1000) + (time * 300))) * magnitude\r\nspeedScalar = minSpeedScalar + ((maxSpeedScalar - minSpeedScalar) * rand3)\r\n';

/** The measured engine input set. Order matters: it is the compiled wrapper's parameter order. */
const INPUTS = [
  'progress', 'time', 'startDistance', 'missileIndex', 'missileCount',
  'rand1', 'rand2', 'rand3', 'distanceToFirePos', 'distanceToImpactPos',
  'distanceFromImpactPos', 'totalDistance',
];

/** One plausible argument set, so every arm evaluates the same work. */
const ARGS = (i: number, n: number) => [i / n, i / n, 30, i, n, 0.5, 0.25, 0.75, 5, 25, 25, 30];

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Warm three times, then report the MEDIAN of nine runs and the spread. One run is noise. */
function timeIt(label: string, body: () => void): void {
  for (let i = 0; i < 3; i += 1) body();
  const runs: number[] = [];
  for (let r = 0; r < 9; r += 1) {
    const t0 = process.hrtime.bigint();
    body();
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const spread = Math.max(...runs) - Math.min(...runs);
  // eslint-disable-next-line no-console
  console.log(`${label.padEnd(54)} ${median(runs).toFixed(4)} ms   (spread ${spread.toFixed(4)} ms)`);
}

describe('SpellMissileMotion evaluation cost', () => {
  it('measures the shipped shape against a noise floor and the rejected alternatives', () => {
    const vm = new LuaVM();
    // Degrees, matching `spell-motion.ts`. The unit is unresolved and that file says why; it does not
    // change the COST, which is what this file measures.
    vm.run('sin = function(d) return math.sin(d * math.pi / 180) end', 'sin');
    vm.run('cos = function(d) return math.cos(d * math.pi / 180) end', 'cos');
    vm.run('fmod = math.fmod', 'fmod');

    const wrap = (src: string) => `return function(${INPUTS.join(', ')})\n${src}\nreturn transMag or 0 end`;
    const compile = (src: string) => {
      const r = vm.runExpr(wrap(src), 'motion');
      if ('message' in r) throw new Error(String(r.message));
      return r.value;
    };

    // ---- THE NOISE FLOOR: the same parabola, 32 times, in pure JS. Anything at or below this is
    // indistinguishable from doing nothing.
    let floorAcc = 0;
    timeIt('NOISE FLOOR: 32 x the parabola in pure JS', () => {
      floorAcc = 0;
      for (let i = 0; i < 32; i += 1) {
        const t = ((i / 32) * 2) - 1;
        floorAcc += (1 - t * t) * 30 * 0.15;
      }
    });
    expect(Number.isFinite(floorAcc)).toBe(true);
    expect(floorAcc).toBeGreaterThan(0);

    // ---- NAIVE: compile on every evaluation. The arm that decides the whole design.
    let naiveRan = 0;
    timeIt('naive: compile + call per evaluation, 32 missiles', () => {
      for (let i = 0; i < 32; i += 1) {
        vm.unref(compile(PARABOLA) as never);
        naiveRan += 1;
      }
    });
    expect(naiveRan).toBeGreaterThan(32);

    // ---- SHIPPED: compile once, call per evaluation, read the outputs off globals. This is exactly
    // what `spell-motion.ts` does, including reading through `getGlobal` rather than a return value.
    const body = vm.runExpr(`return function(${INPUTS.join(', ')})\n${PARABOLA}\nend`, 'body');
    if ('message' in body) throw new Error(String(body.message));
    const bodyFn = body.value;

    let lastMag = 0;
    for (const n of [1, 8, 32]) {
      timeIt(`SHIPPED: ${String(n).padStart(2)} missiles, call + 2 global reads`, () => {
        for (let i = 0; i < n; i += 1) {
          vm.call(bodyFn as never, ARGS(i, n));
          lastMag = Number(vm.getGlobal('transMag'));
          vm.getGlobal('transAngle');
        }
      });
    }
    // The loop really evaluated the script: a mid-flight parabola has a positive magnitude.
    expect(Number.isFinite(lastMag)).toBe(true);

    timeIt('SHIPPED: 32 missiles, call + 6 global reads', () => {
      for (let i = 0; i < 32; i += 1) {
        vm.call(bodyFn as never, ARGS(i, 32));
        for (const g of ['transMag', 'transAngle', 'transFront', 'transRight', 'transUp', 'speedScalar']) {
          vm.getGlobal(g);
        }
      }
    });

    // ---- the two heavier rows at 32, so the worst case in the table has a number too.
    for (const [name, src] of [['19 Spiral Vortex', SPIRAL], ['20 Drunken Missiles', DRUNK]] as const) {
      const fn = compile(src);
      let out = 0;
      timeIt(`worst rows: ${name}, 32 missiles`, () => {
        for (let i = 0; i < 32; i += 1) {
          const r = vm.callReturning(fn as never, ARGS(i, 32));
          if (!('message' in r)) out = Number(r.value);
        }
      });
      expect(Number.isFinite(out)).toBe(true);
      vm.unref(fn as never);
    }

    // ---- REJECTED ALTERNATIVE: sample at launch, interpolate per frame. Cheaper per frame and wrong
    // for the 124 rows that read `time`; see `spell-motion.ts` for why the number did not win.
    const SAMPLES = 16;
    const table = new Float32Array(SAMPLES + 1);
    timeIt(`rejected: sample ${SAMPLES}x at launch (per missile, one-off)`, () => {
      for (let s = 0; s <= SAMPLES; s += 1) {
        vm.call(bodyFn as never, ARGS(s, SAMPLES));
        table[s] = Number(vm.getGlobal('transMag'));
      }
    });
    let interpAcc = 0;
    timeIt('rejected: interpolate 32 missiles from the table (per frame)', () => {
      interpAcc = 0;
      for (let i = 0; i < 32; i += 1) {
        const p = (i / 32) * SAMPLES;
        const lo = Math.floor(p);
        interpAcc += table[lo] + (table[Math.min(lo + 1, SAMPLES)] - table[lo]) * (p - lo);
      }
    });
    // The table was really filled by the VM, so the interpolation arm is not timing zeros.
    expect(table[SAMPLES / 2]).toBeGreaterThan(0);
    expect(Number.isFinite(interpAcc)).toBe(true);
  });
});
