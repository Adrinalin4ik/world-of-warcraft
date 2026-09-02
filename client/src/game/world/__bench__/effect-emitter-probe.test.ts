/**
 * @jest-environment node
 */
import { DecodeStream } from 'restructure';

import M2Parser from '../../../wow-data-parser/m2';
import { evaluateAnimationTrack } from '../../pipeline/m2/particle/tracks';

const { fetchFixture } = require('../../../wow-data-parser/m2/particle/test-support/fixtures');

/**
 * THE PROBE THAT SEPARATES THE TWO SUSPECTS behind the owner's "сам снаряд не анимирован и партиклов
 * нет" -- the projectile flies but is a static shape emitting nothing.
 *
 * Suspect 1 was "nothing advances the model, so no bone motion AND no particles". Suspect 2 was "the
 * emitter's world position is stale, so particles are emitted somewhere other than where the model is
 * drawn". They produce the same picture, so neither was to be fixed before a measurement told them
 * apart. **Both were answered by reading the code, before this probe ran**, and the probe exists to
 * settle the one question reading could not:
 *
 *  - **Suspect 2 is REFUTED for a missile, statically.** `ParticleManager#animate` derives the emitter
 *    world position from `entry.instance.matrixWorld` (`particle/manager.ts:192` for the cull test,
 *    `:253` for the pack), and `world/spell-missile.ts`'s per-frame update already calls
 *    `model.updateMatrix()` then `model.updateMatrixWorld(true)` on the moving model every frame. So
 *    the matrix the manager reads is the one the mesh is drawn from -- (b) and (c) cannot disagree on
 *    this path. The manager's own comment at `:188-191` claims "the renderer's own
 *    scene.updateMatrixWorld() has already produced it this frame", which is FALSE in this scene
 *    (`world/index.ts:232` sets `matrixWorldAutoUpdate = false`) -- but it is false in a way the
 *    missile lane already compensates for, so it is a stale comment rather than this bug.
 *  - **Suspect 1 is REFUTED for the particles, and CONFIRMED for the mesh.** The emitter does not
 *    read the model's animation clock at all: `manager.ts:250-252` steps it with
 *    `entry.emitter.step(dt, entry.emitter.advance(dt))`, and its own comment calls `advance()` "a
 *    self-driven stand-in for the model's animation mixer ... Driving this from the mixer's real time
 *    is Phase 2c". So emission runs whether or not anything poses the model -- posing cannot be what
 *    unblocks particles. The BONES are a different matter: nothing poses a free-standing effect model,
 *    which is exactly why the mesh is static.
 *
 * That left one measurable candidate for the missing particles, and it is what this probe measures:
 * **`ParticleManager.capacityFor` sizes the pool ONCE at register time from the emission rate at
 * `timeMs = 0`** (`manager.ts:259-267`), with a floor of 1. A doodad emits at a constant rate, so its
 * t=0 sample is its real rate. A SPELL effect ramps: if its `emissionRate` track starts at zero, the
 * pool is built with one slot and the emitter can never hold more than one particle no matter how
 * hard it emits later -- which on screen is indistinguishable from no particles at all.
 *
 * The probe reports, per emitter of each real effect model: the emission rate at t=0, the maximum
 * value anywhere in that track, the lifespan, and the capacity `capacityFor` would therefore choose.
 * A model whose rate is 0 at t=0 and large later is the defect; a model whose t=0 rate is already its
 * peak is not.
 *
 * Fixtures are fetched from the asset host and cached, through the project's own `fetchFixture`, which
 * returns null offline so this reports SKIPPED rather than failing an offline checkout.
 */

/** `Fireball_Missile_Low` is the projectile the owner is watching -- `SpellVisual` 67 field 8 = 365. */
const MODELS = [
  'Spells\\Fireball_Missile_Low.mdx',
  'Spells\\LevelUp\\LevelUp.mdl',
  'Particles\\LootFX.mdl',
  'Spells\\ChargeTrail.mdx',
  'Spells\\DustCloud_Land.mdx',
  'Spells\\ThunderClap_Cast_Base.mdx',
  'Spells\\Fire_Precast_Hand.mdx',
  'Spells\\Shadow_Precast_Uber_Hand.mdx',
  'Spells\\Frost_Nova_state.mdx',
];

/** `M2Blueprint.load`'s rewrite, which the asset host requires -- only `.m2` is served. */
const asM2 = (path: string) => path.replace(/\.md(x|l)$/i, '.m2');

/** `ParticleManager.capacityFor`, replicated so the probe reports the number the manager would pick. */
const MAX_PARTICLES_PER_EMITTER = 2000;
const DEFAULT_LIFESPAN_SECONDS = 1;
function capacityFor(definition: any): number {
  const rate = evaluateAnimationTrack(definition.emissionRate, 0, 0, 0);
  const lifespan = evaluateAnimationTrack(definition.lifespan, 0, 0, DEFAULT_LIFESPAN_SECONDS);
  const needed = Math.ceil(Math.max(0, rate) * Math.max(0, lifespan)) + 1;
  return Math.max(1, Math.min(MAX_PARTICLES_PER_EMITTER, needed));
}

/** The largest value anywhere in a track, over every animation it carries. */
function trackMax(block: any): number {
  const tracks = block && block.tracks;
  if (!tracks || tracks.length === 0) {
    return NaN;
  }
  let max = -Infinity;
  for (const track of tracks) {
    for (const value of track.values ?? []) {
      if (typeof value === 'number' && value > max) max = value;
    }
  }
  return max === -Infinity ? NaN : max;
}

describe('spell effect emitters: pool capacity at register time', () => {
  it('reports the t=0 emission rate against the track maximum for real effect models', async () => {
    const lines: string[] = [];
    let measured = 0;
    let starvedEmitters = 0;

    for (const path of MODELS) {
      const buffer = await fetchFixture(asM2(path));
      if (buffer === null) {
        lines.push(`SKIPPED ${path} -- asset host unreachable`);
        continue;
      }
      // The 404-HTML trap: a missing asset answers with a page, and decoding that as an M2 reads its
      // `<!do` as counts. Checked by magic, as the attachment probe learned to.
      if (buffer.slice(0, 4).toString('latin1') !== 'MD20') {
        lines.push(`SKIPPED ${path} -- not an M2 (no MD20 magic), almost certainly a saved 404`);
        continue;
      }

      const m2: any = M2Parser.decode(new DecodeStream(buffer));
      const emitters: any[] = m2.particleEmitters ?? [];
      // THE GEOMETRY HALF -- does this model have a MESH at all, and how big is its authored box?
      // A pure emitter model has no vertices to draw, so a visible sheet cannot be its mesh; a model
      // with vertices and a large bind box drawing unposed is exactly a big flat sheet.
      const verts = (m2.vertices ?? []).length;
      const seqs = (m2.animations ?? []).length;
      const animatedBones = (m2.bones ?? []).filter((b: any) => b && b.animated).length;
      // `Vec3Float` decodes to an OBJECT with x/y/z, not an array -- indexing it gave NaN on the
      // first run of this probe, which is exactly the kind of instrument error the project's record
      // says to expect and check for.
      const span = (a: any, b: any, k: string) => (
        a && b && typeof a[k] === 'number' && typeof b[k] === 'number' ? b[k] - a[k] : NaN);
      const box = [
        span(m2.minVertexBox, m2.maxVertexBox, 'x'),
        span(m2.minVertexBox, m2.maxVertexBox, 'y'),
        span(m2.minVertexBox, m2.maxVertexBox, 'z'),
      ].map((v: number) => (Number.isFinite(v) ? v.toFixed(2) : '?')).join(' x ');
      lines.push(
        `${path}  v${m2.version}  emitters=${emitters.length}  textures=${(m2.textures ?? []).length}`
        + `  VERTICES=${verts}  sequences=${seqs}  animatedBones=${animatedBones}`
        + `  authoredBox=${box}  radius=${(m2.vertexRadius ?? 0).toFixed(2)}`,
      );

      for (let i = 0; i < emitters.length; i += 1) {
        const definition = emitters[i];
        const rate0 = evaluateAnimationTrack(definition.emissionRate, 0, 0, 0);
        const rateMax = trackMax(definition.emissionRate);
        const life0 = evaluateAnimationTrack(definition.lifespan, 0, 0, DEFAULT_LIFESPAN_SECONDS);
        const capacity = capacityFor(definition);
        // `register` skips an emitter whose textureId names no filename -- that would be a different
        // cause with a different fix, so it is reported alongside.
        const texture = (m2.textures ?? [])[definition.textureId];
        const texturePath = texture && texture.filename ? texture.filename : '';
        const starved = capacity <= 1 && Number.isFinite(rateMax) && rateMax > 1;
        if (starved) starvedEmitters += 1;
        measured += 1;
        lines.push(
          `   emitter ${String(i).padStart(2)}  rate(t=0)=${rate0.toFixed(3).padStart(9)}`
          + `  rateMax=${Number.isFinite(rateMax) ? rateMax.toFixed(3).padStart(9) : '     none'}`
          + `  lifespan=${life0.toFixed(3)}  CAPACITY=${String(capacity).padStart(5)}`
          + `  texture=${texturePath ? 'ok' : 'MISSING'}`
          + (starved ? '   <-- STARVED: one slot, but emits later' : ''),
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(lines.join(String.fromCharCode(10)));
    // eslint-disable-next-line no-console
    console.log(`emitters measured: ${measured}   starved by the t=0 capacity rule: ${starvedEmitters}`);

    // No assertion on the counts: offline this measures nothing and must not fail. The probe's job is
    // the report -- the numbers it produced are recorded on `world/spell-kit-effects.ts`.
    expect(measured).toBeGreaterThanOrEqual(0);
  }, 60000);
});
