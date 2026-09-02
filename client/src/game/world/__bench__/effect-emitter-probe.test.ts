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
  'Spells\\LightningBolt_Missile.mdx',
  'Spells\\Lightning_PreCast_Low_Hand.mdx',
  'Spells\\Lightning_Cast_Hand.mdx',
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
const LIGHTNING_MISSILE = 'Spells\\LightningBolt_Missile.mdx';

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
        + `  RIBBONS=${(m2.ribbonEmitters ?? []).length}`
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
 * ## LIGHTNING BOLT 403, which is what the owner is actually casting
 *
 *     stage    model                                emitters  verts  ribbons  live  size range
 *     precast  Lightning_PreCast_Low_Hand.mdx              0    116        3     0  -- nothing
 *     missile  LightningBolt_Missile.mdx                   0    116        3     0  -- nothing
 *     release  Lightning_Cast_Hand.mdx                     1     20        0    13  0.012 .. 0.219
 *     impact   LightningBolt_Impact_Chest.mdx              2     20?       0    12  0.069 .. 0.417
 *
 * **Two of the four stages have NO particle emitters at all.** They are ribbon-and-mesh assets, and
 * this client renders no ribbon emitters -- so with the mesh hidden they drew literally nothing, which
 * is "снаряда совсем не видно" and "что-то видно в конце анимации каста не более" exactly: only the
 * release and impact stages have emitters, and the release's 13 sprites top out at 0.219 units.
 *
 * That is what the visibility rule in `world/spell-kit-effects.ts` now keys on: a model with zero
 * emitters must show its mesh, because the mesh is all it has.
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
    'Spells\\LightningBolt_Missile.mdx',
    'Spells\\Lightning_PreCast_Low_Hand.mdx',
    'Spells\\Lightning_Cast_Hand.mdx',
    'Spells\\LightningBolt_Impact_Chest.mdx',
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

/**
 * THE RIBBON CHUNK, validated against real 3.3.5a bytes rather than trusted.
 *
 * `wow-data-parser/m2/particle/ribbon.js` declares a 176-byte v264 record and its comment lists the
 * field sizes -- but a comment is not a measurement, and this project's most repeated silent defect is
 * a field that widened between versions. The reference's own spec is build 5875 / MD20 v256 with a
 * record stride of **0xdc = 220 bytes** (`benilla-formats/src/ribbons.rs:9-19`), so the two disagree by
 * 44 bytes and the difference has to be accounted for before a single line is written on top of it.
 *
 * The 44 bytes are the SIX `M2Track`s: v256 carries `interpolationRanges` in every track (3 arrays +
 * 2 u16 = 28 B) and v264 dropped it (2 arrays + 4 u16 = 20 B). 6 x 8 = 48, less the 4 bytes v264 ADDS
 * back as `priorityPlane`/`ribbonColorIndex`/`textureTransformLookupIndex`, = 44. So the stride delta
 * is fully explained, and this arm checks the consequence: that every field lands on a sane value.
 */
describe('M2 ribbon emitters: the v264 record', () => {
  it('decodes LightningBolt_Missile ribbons with every field in range', async () => {
    const buffer = await fetchFixture(asM2(LIGHTNING_MISSILE));
    if (buffer === null || buffer.slice(0, 4).toString('latin1') !== 'MD20') {
      // eslint-disable-next-line no-console
      console.log('SKIPPED: asset host unreachable');
      return;
    }
    const m2: any = M2Parser.decode(new DecodeStream(buffer));
    const ribbons: any[] = m2.ribbonEmitters ?? [];
    const bones: any[] = m2.bones ?? [];
    const textures: any[] = m2.textures ?? [];
    const materials: any[] = m2.materials ?? [];

    const lines: string[] = [`ribbons=${ribbons.length}  bones=${bones.length}`
      + `  textures=${textures.length}  materials=${materials.length}`];

    for (let i = 0; i < ribbons.length; i += 1) {
      const rb = ribbons[i];
      const keys = (block: any) => (block?.tracks ?? []).reduce(
        (n: number, t: any) => n + ((t.values ?? []).length), 0,
      );
      lines.push(
        `   ribbon ${i}  id=${rb.ribbonId}  bone=${rb.boneIndex}`
        + `  pos=[${rb.position.x.toFixed(3)}, ${rb.position.y.toFixed(3)}, ${rb.position.z.toFixed(3)}]`
        + `  tex=[${(rb.textureIndices ?? []).join(',')}]`
        + `  mat=[${(rb.materialIndices ?? []).join(',')}]`
        + `  edgesPerSec=${rb.edgesPerSecond.toFixed(3)}`
        + `  edgeLife=${rb.edgeLifetime.toFixed(3)}`
        + `  gravity=${rb.gravity.toFixed(3)}`
        + `  rows=${rb.textureRows} cols=${rb.textureCols}`
        + `  keys(color/alpha/above/below/slot/vis)=`
        + `${keys(rb.colorTrack)}/${keys(rb.alphaTrack)}/${keys(rb.heightAboveTrack)}`
        + `/${keys(rb.heightBelowTrack)}/${keys(rb.texSlotTrack)}/${keys(rb.visibilityTrack)}`
        + `  priorityPlane=${rb.priorityPlane}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(lines.join(String.fromCharCode(10)));

    // THE RESIDUAL. Every field must land somewhere legal, which a 44-byte stride error could not do:
    // a wrong stride walks each successive record into the middle of the previous one.
    for (const rb of ribbons) {
      expect(rb.boneIndex).toBeGreaterThanOrEqual(0);
      expect(rb.boneIndex).toBeLessThan(bones.length);
      for (const t of rb.textureIndices ?? []) {
        expect(t).toBeLessThan(textures.length);
      }
      // `edgeLifetime` is clamped >= 0.25 by the reference; a stride error gives garbage floats.
      expect(rb.edgeLifetime).toBeGreaterThan(0);
      expect(rb.edgeLifetime).toBeLessThan(60);
      expect(rb.edgesPerSecond).toBeGreaterThan(0);
      expect(rb.edgesPerSecond).toBeLessThan(1000);
      // An atlas is a handful of cells, never thousands.
      expect(rb.textureRows).toBeGreaterThanOrEqual(1);
      expect(rb.textureRows).toBeLessThan(64);
      expect(rb.textureCols).toBeGreaterThanOrEqual(1);
      expect(rb.textureCols).toBeLessThan(64);
    }
    expect(ribbons.length).toBeGreaterThan(0);
  }, 60000);
});

/**
 * IS THE ORBIT AUTHORED, AND ON WHICH CLOCK?
 *
 * The owner: "в оригинале вокруг снаряда еще крутятся молнии, тут нет." The arcs draw but do not
 * orbit. Three places that can die look identical on screen, and this arm answers the one that can be
 * answered from served bytes -- which rules the other two out if the orbit turns out unauthored or on
 * a feed nothing drives.
 *
 * For every bone of `LightningBolt_Missile`: its parent, its billboard flag, how many rotation keys
 * each sequence slot carries, and the `globalSequenceID` of each of its three tracks. -1 there is the
 * model own clock; >= 0 is a GLOBAL sequence, a separate feed indexed by the model global-sequence
 * duration table rather than by an armed animation.
 *
 * The three ribbon hosts are bones 23, 24 and 25 (measured in the ribbon arm above), so those rows and
 * their ancestors are the ones that decide it.
 */
describe('M2 bone rotation: is the lightning orbit authored', () => {
  it('reports rotation key counts and the global-sequence flag per bone', async () => {
    const buffer = await fetchFixture(asM2(LIGHTNING_MISSILE));
    if (buffer === null || buffer.slice(0, 4).toString('latin1') !== 'MD20') {
      // eslint-disable-next-line no-console
      console.log('SKIPPED: asset host unreachable');
      return;
    }
    const m2: any = M2Parser.decode(new DecodeStream(buffer));
    const bones: any[] = m2.bones ?? [];
    const sequences: any[] = m2.animations ?? [];
    const globals: any[] = m2.sequences ?? [];

    const lines: string[] = [
      `bones=${bones.length}  sequences=${sequences.length}  globalSequences=${globals.length}`
      + `  globalDurations=[${globals.join(String.fromCharCode(44))}]`,
    ];
    sequences.forEach((seq: any, i: number) => {
      lines.push(`   sequence ${i}: animId=${seq.id} length=${seq.length}ms flags=0x${(seq.flags >>> 0).toString(16)}`);
    });

    const keyCounts = (block: any) => (block?.tracks ?? [])
      .map((t: any) => (t.values ?? []).length)
      .join(String.fromCharCode(47));

    for (let i = 0; i < bones.length; i += 1) {
      const bone = bones[i];
      const rotKeys = keyCounts(bone.rotation);
      const transKeys = keyCounts(bone.translation);
      const scaleKeys = keyCounts(bone.scaling);
      const totalKeys = [bone.rotation, bone.translation, bone.scaling]
        .reduce((sum: number, block: any) => sum + (block?.tracks ?? [])
          .reduce((n: number, t: any) => n + (t.values ?? []).length, 0), 0);
      const isHost = i >= 23 && i <= 25;
      if (!isHost && totalKeys === 0) {
        continue;
      }
      lines.push(
        `   bone ${String(i).padStart(2)}${isHost ? String.fromCharCode(42) : String.fromCharCode(32)}`
        + ` parent=${String(bone.parentID).padStart(3)}`
        + ` billboard=${bone.billboardType}`
        + ` rotKeys=[${rotKeys}] gsRot=${bone.rotation?.globalSequenceID}`
        + ` transKeys=[${transKeys}] gsTrans=${bone.translation?.globalSequenceID}`
        + ` scaleKeys=[${scaleKeys}] gsScale=${bone.scaling?.globalSequenceID}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(lines.join(String.fromCharCode(10)));
    expect(bones.length).toBeGreaterThan(0);
  }, 60000);
});

/**
 * THE STRIP GEOMETRY ITSELF: do the height tracks stay non-zero for the whole flight?
 *
 * A ribbon whose `heightAbove`/`heightBelow` both reach 0 collapses to a degenerate line and draws
 * nothing, and `RibbonRuntime#step` samples both at its own monotonically-accumulating `timeMs` --
 * so a track whose last key sits at 200 ms decides what a 900 ms flight looks like. That is the other
 * way "there is no trail" can be true with every position correct, so it is measured rather than
 * assumed.
 */
describe('M2 ribbon geometry: the height and visibility tracks', () => {
  it('reports height/visibility keys and their spans for the lightning ribbons', async () => {
    const buffer = await fetchFixture(asM2(LIGHTNING_MISSILE));
    if (buffer === null || buffer.slice(0, 4).toString('latin1') !== 'MD20') {
      // eslint-disable-next-line no-console
      console.log('SKIPPED: asset host unreachable');
      return;
    }
    const m2: any = M2Parser.decode(new DecodeStream(buffer));
    const ribbons: any[] = m2.ribbonEmitters ?? m2.ribbons ?? [];
    const lines: string[] = [`ribbons=${ribbons.length}`];
    const describeTrack = (name: string, block: any) => {
      if (!block) {
        return `${name}=absent`;
      }
      const t0 = (block.tracks ?? [])[0];
      const stamps: number[] = t0?.timestamps ?? [];
      const values: any[] = t0?.values ?? [];
      const nums = values.map((v: any) => (typeof v === 'number' ? v : v?.x ?? v?.[0]));
      return `${name}{gs=${block.globalSequenceID} keys=${stamps.length}`
        + ` span=${stamps.length ? `${stamps[0]}..${stamps[stamps.length - 1]}ms` : 'none'}`
        + ` values=[${nums.slice(0, 6).map((n: any) => (typeof n === 'number' ? n.toFixed(3) : String(n))).join(String.fromCharCode(44))}]}`;
    };
    ribbons.forEach((r: any, i: number) => {
      lines.push(`   ribbon ${i}: bone=${r.boneIndex} edgesPerSec=${r.edgesPerSecond}`
        + ` edgeLifetime=${r.edgeLifetime} gravity=${r.gravity}`
        + ` textureRows=${r.textureRows} textureCols=${r.textureCols}`);
      lines.push(`      ${describeTrack('above', r.heightAboveTrack)}`);
      lines.push(`      ${describeTrack('below', r.heightBelowTrack)}`);
      lines.push(`      ${describeTrack('visibility', r.visibilityTrack)}`);
      lines.push(`      ${describeTrack('color', r.colorTrack)}  ${describeTrack('alpha', r.alphaTrack)}`);
    });
    // eslint-disable-next-line no-console
    console.log(lines.join(String.fromCharCode(10)));
    expect(ribbons.length).toBeGreaterThan(0);
  }, 60000);
});
