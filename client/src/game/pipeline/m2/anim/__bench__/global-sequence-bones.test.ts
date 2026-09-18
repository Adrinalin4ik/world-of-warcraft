/** @jest-environment node */
/**
 * THE COST OF HONOURING `globalSequenceID` ON THE BONE PATH, and the population it changes.
 *
 * `solveBone` is the hottest animation path there is -- per bone, per posed instance, per frame -- so
 * this prices the change on REAL rigs rather than on a fixture, and it prices the two paths
 * separately, because they are two different questions:
 *
 *   * The `globalSequenceID === -1` path is every bone of every model in the game. What the change
 *     adds there is one int field read and one compare per call, no allocation and no map lookup, and
 *     the arm below measures it as a whole-solve time so the claim is a number and not an assertion.
 *     A/B it against the parked baseline with
 *     `git stash push -- src/game/pipeline/m2/anim/instance-anim.ts src/game/pipeline/m2/anim/model-anim.ts`,
 *     which leaves this untracked file in place to run on both sides.
 *   * The global path is the work that did not happen before at all: a `globalSequenceCursor` (one
 *     array read plus a modulo) and a sample per global channel.
 *
 * NOT a jest-timed assertion on a wall clock, which this project has been burned by. The arm reports
 * and asserts only that the solve ran; the number goes in the round's report with its own noise floor.
 */
import { InstanceAnim } from '../instance-anim';
import { ModelAnim } from '../model-anim';
import { DecodeStream } from 'restructure';
import M2Parser from '../../../../../wow-data-parser/m2';

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { fetchFixture } = require('../../../../../wow-data-parser/m2/particle/test-support/fixtures');

/** Rigs chosen for what they are, not for being convenient. See the report for the population survey. */
const RIGS = [
  // THE PURE `-1` ARM, and the one that answers "what did you change on the path every model takes":
  // 140 bones, 115 of them animated, 36 sequences and NOT ONE global-sequence bone channel. Picked by
  // surveying the cache for the largest all-`-1` rig rather than by name, so the two 140-bone arms
  // (this and HumanMale) differ in the measured variable and little else.
  'Creature/Dragon/Lethon.m2',
  // 138 bones, 156 sequences, 3 global sequences, 13 global-sequence bone channels.
  'Character/Human/Male/HumanMale.m2',
  // 26 bones, 1 sequence, 18 global sequences -- EVERY animated track it has is global.
  'Spells/LightningBolt_Missile.m2',
  // 6 bones, 1 global-sequence scaling channel: Elwynn's lamppost, which the owner walks past.
  'World/Azeroth/Elwynn/PassiveDoodads/Lamppost/Lamppost.m2',
];

const ITERATIONS = 800;
const RUNS = 15;

describe('global-sequence bone channels: cost and population', () => {
  it('times a whole solve on real rigs and counts the global channels', async () => {
    const lines: string[] = [];
    for (const path of RIGS) {
      // eslint-disable-next-line no-await-in-loop
      const buffer = await fetchFixture(path);
      if (buffer === null || buffer.slice(0, 4).toString('latin1') !== 'MD20') {
        lines.push(`${path}: SKIPPED (asset host unreachable)`);
        continue;
      }
      const data: any = M2Parser.decode(new DecodeStream(buffer));
      const model = new ModelAnim(data);
      const inst = new InstanceAnim(model);
      if (model.sequences.length > 0) {
        inst.arm(model.sequences[0], 0);
      }

      let gsChannels = 0;
      let gsBones = 0;
      for (const def of model.boneDefs) {
        let hit = 0;
        for (const block of [def.translation, def.rotation, def.scaling]) {
          if (block && block.globalSequenceID > -1 && (block.tracks ?? []).length > 0) {
            hit += 1;
          }
        }
        gsChannels += hit;
        if (hit > 0) {
          gsBones += 1;
        }
      }

      // Warm the JIT on the same shape before timing it -- an unwarmed first solve is several times
      // the steady-state cost and would flatter or slander whichever side ran first.
      for (let i = 0; i < 400; i += 1) {
        inst.solveBones(i * 16);
      }
      const samples: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const start = process.hrtime.bigint();
        for (let i = 0; i < ITERATIONS; i += 1) {
          inst.solveBones(i * 16);
        }
        samples.push(Number(process.hrtime.bigint() - start) / 1e6 / ITERATIONS);
      }
      samples.sort((a, b) => a - b);
      lines.push(`${path}`);
      lines.push(`   bones=${model.boneDefs.length} sequences=${model.sequences.length}`
        + ` globalSequenceBones=${gsBones} globalSequenceChannels=${gsChannels}`);
      const median = samples[(RUNS - 1) >> 1];
      lines.push(`   solveBones median=${median.toFixed(4)}ms`
        + ` min=${samples[0].toFixed(4)} max=${samples[RUNS - 1].toFixed(4)}`
        + ` p25=${samples[Math.floor(RUNS * 0.25)].toFixed(4)}`
        + `  (${ITERATIONS} solves x ${RUNS} runs)`);
      expect(model.boneDefs.length).toBeGreaterThan(0);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }, 120000);
});
