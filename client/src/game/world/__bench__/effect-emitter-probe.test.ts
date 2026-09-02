/**
 * @jest-environment node
 */
import { DecodeStream } from 'restructure';

import M2Parser from '../../../wow-data-parser/m2';
import { evaluateAnimationTrack } from '../../pipeline/m2/particle/tracks';

const { fetchFixture } = require('../../../wow-data-parser/m2/particle/test-support/fixtures');

/**
 * THE TEXTURE LOADER IS MOCKED, and it had to be: `ParticleManager.register` builds a
 * `ParticleMaterial` per emitter and each constructor calls `TextureLoader.load`. Unmocked in a node
 * environment that call never settles, so the last-hop arm below hung with an EMPTY output file --
 * the run produced no numbers at all until this was added. A `load` that never resolves is also the
 * right stand-in here: the packed size and alpha this probe measures come from the emitter's own
 * tracks, not from the texture, so the placeholder is exactly what a first frame really draws with.
 */
jest.mock('../../pipeline/texture-loader', () => ({
  __esModule: true,
  default: {
    PLACEHOLDER: new (require('three').Texture)(),
    load: jest.fn(() => new Promise(() => {})),
    unload: jest.fn(),
  },
}));

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

/**
 * THE LAST HOP -- what actually reaches the renderer for one cast's emitters.
 *
 * The owner's report is "ошибок нет, но и визуала я не вижу ... скорее всего размер как-то поменялся".
 * Every state fact upstream of this is already verified (handle returned, pool sized, emitter stepped,
 * batch built), and `CLAUDE.md`'s rule is that a draw call is not a pixel: so this measures the packed
 * INSTANCE ATTRIBUTES the shader reads, which is the last thing before pixels that a headless rig can
 * see.
 *
 * Answerable here: live particle count, packed `iScale` (the billboard size in world units), packed
 * alpha, the packed positions against the emitter's world matrix, the batch's own `visible`, and
 * whether the manager culled it.
 *
 * NOT answerable here, and named rather than implied: whether `map.particleGroup` is in the rendered
 * scene graph on a live frame, whether the camera is actually within `CULL_DISTANCE` of the caster in
 * play, and whether the material's shader compiled. Those need the browser.
 *
 * ## WHAT IT MEASURED, and it refutes every suspect it can reach
 *
 *     Fireball_Missile_Low.mdx  registered=4  liveParticles=106
 *        blend=ADD_ALPHA  count= 52  visible=true  size=[0.074 .. 0.278]  alpha=[0.025 .. 0.537]
 *        blend=ADD_ALPHA  count= 26  visible=true  size=[0.172 .. 0.222]  alpha=[0.000 .. 0.961]
 *        blend=ALPHA      count= 26  visible=true  size=[0.111 .. 0.222]  alpha=[0.000 .. 0.961]
 *        blend=ADD_ALPHA  count=  2  visible=true  size=[1.940 .. 3.771]  alpha=[0.723 .. 0.723]
 *     Fire_Precast_Hand.mdx     registered=5  liveParticles=96   (sizes 0.036 .. 0.642, alpha to 1.0)
 *     DustCloud_Land.mdx        registered=1  liveParticles=20   (size 0.139 .. 0.394, alpha to 0.228)
 *
 * Emission WORKS (106/96/20 particles alive after one second of steps). Sizes are sensible world
 * units, not zero and not microscopic. Alpha reaches 0.96/1.0/0.23. Packed positions sit 0.03-1.31
 * from the emitter, so nothing is stranded at the world origin. Every batch reports `visible=true`,
 * and `ParticleBatch` sets `frustumCulled = false` (`batch.ts:75`), so three cannot drop them either.
 * `ADD_ALPHA` -- which is what almost every one of these emitters uses -- maps to
 * `SrcAlphaFactor`/`OneFactor`, correct additive.
 *
 * `DustCloud_Land`'s 20 live particles are the capacity fix working: before it, that emitter had one
 * slot.
 *
 * ## THE SIZE DISTRIBUTION PER STAGE, and why one global multiplier cannot serve two
 *
 * The owner: "во время каста виден листочек если скейл сделать больше. Но вот конец каста тогда имеет
 * слишком большой скейл." Fireball's precast and release are DIFFERENT assets on the same hands
 * (`SpellVisualKit` 30 slot handA/B -> effect 287, kit 38 -> effect 288), so their authored sizes were
 * measured side by side:
 *
 *     stage    model                          emitters  live  size range      ratePeak x life
 *     precast  Fire_Precast_Hand.mdx                 5    96  0.036 .. 0.642  40x0.7, 65x0.5, 10x0.25
 *     release  Fire_Cast_Hand.mdx                    3    17  0.250 .. 0.863  21x0.3, 15x0.3
 *     impact   MoltenBlast_Impact_Chest.mdx          6   131  0.030 .. 1.886  100x0.3 .. 20x0.8
 *
 * **The maxima differ by only 1.34x -- but the MINIMA by 7x, and that is the whole problem.** Two
 * thirds of the precast's 96 particles live in batches whose sprites are 0.037 to 0.083 (3-8 cm), and
 * it has exactly TWO large ones. Every one of the release's 17 particles is 0.25 to 0.86. So the
 * multiplier the precast's smallest sprites need to become visible is ~8x, and at 8x the release's
 * 0.86 sprites become ~6.9 units -- a seven-metre sprite on a two-metre body, which is the green cloud
 * swallowing the screen. **A single global knob is confirmed the wrong shape, with the number.**
 *
 * The density reading is supported too: the release is genuinely SPARSE -- 17 particles, rate 15-21
 * over a 0.3 s life -- so it is a few big sprites rather than a dense blob, which is what the second
 * screenshot shows.
 *
 * One oddity worth a later look: `MoltenBlast_Impact_Chest` batch 0 has `ratePeak` 100 and packed
 * ZERO particles, while its five siblings packed 11-71. Not chased here.
 *
 * ## SO THE FAILURE IS BROWSER-ONLY, AND THE SUBSYSTEM DEMONSTRABLY DRAWS
 *
 * The owner has seen particles from this same manager, group, material and batch: commit `3304d2a`
 * exists because he distinguished the loot sparkle's CLOUD RADIUS from its PARTICLE SIZE
 * ("не увеличивает размер партикла, а только радиус вокруг куста"). So `ParticleManager` reaches
 * pixels, and whatever stops the spell lanes is specific to them and invisible to a headless rig.
 *
 * The one structural difference between the lane he has seen and the lanes he has not:
 * `world/game-object-sparkle.ts` adopts its model on the FRAME TICK, while
 * `world/spell-kit-effects.ts` and `world/spell-missile.ts` register inside a promise handler. That
 * difference is recorded here and deliberately NOT acted on: no mechanism connects microtask-time
 * registration to an invisible emitter (the manager stores the entry and steps it on the next
 * `animate` either way), and `CLAUDE.md` records five plausible diagnoses failing on one bug here.
 * Copying a working lane without a mechanism is how that happens again.
 */
describe('spell effect emitters: the last hop to the renderer', () => {
  // FIREBALL'S THREE STAGES, side by side. Precast and release are different assets on the same
  // hands (effects 287 and 288), which is what makes a single global size multiplier the wrong
  // shape if their authored sizes differ by much.
  const LAST_HOP_MODELS = [
    'Spells\\Fire_Precast_Hand.mdx',
    'Spells\\Fire_Cast_Hand.mdx',
    'Spells\\MoltenBlast_Impact_Chest.mdx',
    'Spells\\Fireball_Missile_Low.mdx',
    'Spells\\DustCloud_Land.mdx',
  ];

  it('reports live particles, packed size and packed alpha for real effect models', async () => {
    /* eslint-disable global-require */
    const THREE = require('three');
    const { ParticleManager } = require('../../pipeline/m2/particle/manager');
    /* eslint-enable global-require */

    const lines: string[] = [];

    for (const path of LAST_HOP_MODELS) {
      const buffer = await fetchFixture(asM2(path));
      if (buffer === null || buffer.slice(0, 4).toString('latin1') !== 'MD20') {
        lines.push(`SKIPPED ${path}`);
        continue;
      }
      const m2: any = M2Parser.decode(new DecodeStream(buffer));

      // The instance the manager registers. A bare `Object3D` standing in for the loaded M2 -- the
      // manager only reads `particleEmitters`, `textures`, `matrixWorld` and `bones` off it, and using
      // a real `M2` here would drag in `collisionWorld` and the worker pool.
      const instance: any = new THREE.Object3D();
      instance.particleEmitters = m2.particleEmitters ?? [];
      instance.textures = m2.textures ?? [];
      instance.path = path;
      // A plausible caster position, so a wrong packed position is visible as a wrong number rather
      // than as a zero that happens to match the origin.
      instance.position.set(100, 200, 30);
      instance.updateMatrix();
      instance.updateMatrixWorld(true);

      const group = new THREE.Group();
      const manager = new ParticleManager(group);
      const registered = manager.register(instance);

      // The camera sits AT the emitter, so `CULL_DISTANCE` cannot be what hides anything here -- that
      // isolates the cull from the size question rather than confounding the two.
      const camera = new THREE.PerspectiveCamera();
      camera.position.copy(instance.position);

      // A second of frames at 60 fps: long enough for every lifespan measured (0.2 s to 1.5 s) to
      // have spawned and for a ramped rate track to have reached its peak.
      for (let i = 0; i < 60; i += 1) {
        manager.animate(1 / 60, camera);
      }

      lines.push(`${path}  registered=${registered}  liveParticles=${manager.liveParticleCount}`);

      for (let b = 0; b < group.children.length; b += 1) {
        const batch: any = group.children[b];
        const geometry = batch.geometry;
        const count = geometry.instanceCount;
        const scales = geometry.getAttribute('iScale');
        const colors = geometry.getAttribute('iColor');
        const offsets = geometry.getAttribute('iOffset');

        const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : 'n/a');
        let minScale = Infinity; let maxScale = -Infinity;
        let minAlpha = Infinity; let maxAlpha = -Infinity;
        let maxOffsetFromEmitter = 0;
        for (let i = 0; i < count; i += 1) {
          const sx = scales.array[i * 2];
          const sy = scales.array[i * 2 + 1];
          minScale = Math.min(minScale, sx, sy);
          maxScale = Math.max(maxScale, sx, sy);
          const a = colors.array[i * 4 + 3];
          minAlpha = Math.min(minAlpha, a);
          maxAlpha = Math.max(maxAlpha, a);
          const dx = offsets.array[i * 3] - instance.position.x;
          const dy = offsets.array[i * 3 + 1] - instance.position.y;
          const dz = offsets.array[i * 3 + 2] - instance.position.z;
          maxOffsetFromEmitter = Math.max(maxOffsetFromEmitter, Math.hypot(dx, dy, dz));
        }

        const definition: any = instance.particleEmitters[b];
        const BLEND = ['OPAQUE', 'ALPHA_KEY', 'ALPHA', 'ADD', 'ADD_ALPHA', 'MODULATE', 'MODULATE_2X'];
        lines.push(
          `   batch ${String(b).padStart(2)}  blend=${definition ? (BLEND[definition.blendingType] ?? definition.blendingType) : '?'}`
          + `  ratePeak=${fmt(trackMax(definition?.emissionRate))}`
          + `  life=${fmt(evaluateAnimationTrack(definition?.lifespan, 0, 0, 1))}`
          + `  instanceCount=${String(count).padStart(4)}`
          + `  visible=${batch.visible}`
          + `  size=[${fmt(minScale)} .. ${fmt(maxScale)}]`
          + `  alpha=[${fmt(minAlpha)} .. ${fmt(maxAlpha)}]`
          + `  maxSpread=${fmt(maxOffsetFromEmitter)}`
          + (count === 0 ? '   <-- NOTHING PACKED' : '')
          + (count > 0 && maxScale <= 0.001 ? '   <-- ZERO SIZE' : '')
          + (count > 0 && maxAlpha <= 0.001 ? '   <-- ZERO ALPHA' : ''),
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(lines.join(String.fromCharCode(10)));
    expect(lines.length).toBeGreaterThan(0);
  }, 60000);
});
