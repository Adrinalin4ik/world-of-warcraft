# M2 Particle System — Design

Date: 2026-07-30
Branch: `feature/remote-assets`

## Problem

The client has no particle system. `client/src/wow-data-parser/m2/index.js` declares
`particleEmitters: new Nofs()` with no element type, which reads the array count and discards the
offset, so emitter data is never parsed. `ribbonEmitters` is the same.

The visible consequence: particle-emitter doodads render as opaque blobs. At Blackrock
(`-7545, -1153, 177`) two WMO doodads sit 9–10 units apart —
`WORLD\GENERIC\PASSIVEDOODADS\PARTICLEEMITTERS\LAVASPLASHPARTICLE.M2` (texture `BALL1.BLP`) and
`WORLD\GENERIC\PASSIVEDOODADS\PARTICLEEMITTERS\LAVASMOKEEMITTERB.M2` (texture
`CREATURE\GHOST\BLACK32.BLP`). Each carries a 6-vertex submesh with an `M2Material` at
`BLENDING_MODE = 0` (opaque). These are particle *template* quads; the real client never draws them
directly, it instantiates them per particle with the emitter's blend mode, colour and scale. Drawn
opaque, they read as a dark lump with an off-colour fringe over the lava.

So the system has to be built, and the template geometry has to stop rendering.

## Decisions

| Question | Decision |
| --- | --- |
| Fidelity | Full — all documented emitter features, including tumble, drag, spline paths, multi-texture, and ribbon emitters |
| Consumers | World doodads **and** creatures/spells: bone-bound emitters and a runtime spawn/stop API from the start |
| Load behaviour | Global particle cap with distance culling |
| Architecture | CPU simulation, instanced batched rendering |
| Verification | Jest unit tests for parser and simulation math; visual behaviour validated in-game by the user |

Ribbon emitters are a separate unit. They are trailing strips built from a bone's motion history, not
particles; forcing them through a shared "particle" abstraction would compromise both.

## Architecture

```
wow-data-parser/m2/particle/
  part-track.js   FBlock / M2PartTrack decoder + fixed16 conversion
  emitter.js      M2Particle struct
  ribbon.js       M2Ribbon struct

game/pipeline/m2/particle/
  pool.ts         SoA typed-array particle storage + free list
  emitter.ts      one live emitter: state, emission accumulator, transform
  spawn.ts        one spawn function per emitterType
  integrate.ts    per-step motion: gravity, drag, tumble, zSource
  batch.ts        InstancedBufferGeometry + instanced attribute upload
  material.ts     ShaderMaterial, blend modes 0-6, billboarding
  manager.ts      ParticleManager: registry, budget allocator, batch ownership
```

Data flows one way: parser → emitter definitions → live emitters → pool writes → batch attribute
buffers → GPU. Nothing downstream writes back upstream.

### Parser layer

`part-track.js` decodes `M2PartTrack`/`FBlock`: fixed-size parallel arrays of times and values, used
for the tracks that vary over a *particle's lifetime* rather than over animation time. This is a
different structure from the existing `AnimationBlock`, which is keyed on animation timestamps and is
reused as-is for the emitter's animated *inputs*. Value types needed: `fixed16` (converted as
`value / 32767`), `C3Vector`, `C2Vector`, `uint16`.

`emitter.js` decodes `M2Particle`: identity and flags, `bone`, `texture`, `blendingType`,
`emitterType` (plane / sphere / spline / bone), `headOrTail`, texture tiling rows and columns, the
`M2Track<float>` inputs (emission speed, speed variation, vertical range, horizontal range, gravity,
lifespan, emission rate, emission area length and width, `zSource`), the `FBlock` lifetime tracks
(colour, alpha, scale, head cell, tail cell), `scaleVary`, and `enabledIn`.

`index.js` then changes `particleEmitters` and `ribbonEmitters` to pass the element type.

**Byte layout is transcribed from wowdev.wiki's M2 particle section at implementation time, not from
memory.** A single wrong offset yields plausible-looking garbage rather than an error, so three checks
pin it down:

1. Parsing *N* emitters consumes exactly *N* × struct size and lands on the offset the header gives
   for the following chunk.
2. Real models produce values in sane ranges: lifespans of seconds, emission rates below a few
   hundred, texture indices within the model's texture array.
3. `emitterType` is one of the four documented values for every emitter across the fixture corpus.

Check 3 is the strongest: a misaligned struct almost never yields a valid enum across a dozen files.

### Simulation

Particles are stored structure-of-arrays in typed buffers — position, velocity, age, lifespan, seed —
with a free list for allocation. No per-particle objects.

Each live emitter holds its definition, a reference to the owning M2 instance for world transform and
bone matrix, and a *fractional* emission accumulator so that a low emission rate does not quantise to
zero particles per frame at high frame rates.

Spawning is one function per `emitterType`. Plane picks a random point inside the length × width area
and a direction perturbed by the horizontal and vertical range angles. Sphere picks a direction across
the range. Spline and bone are implemented for completeness and expected to be rare.

Integration per step applies gravity, then drag and tumble where the flags call for them, then
`zSource` pulling velocity toward a point below the emitter, then position.

Lifetime values are read from the `FBlock`s at `t = age / lifespan`: colour, alpha, scale, and the
head or tail cell index that selects a sub-rect of the rows × columns texture tiling. Every particle
stores a seed so its random variation is stable frame to frame instead of jittering. `enabledIn` gates
emission on the owning model's current animation.

### Rendering

One `InstancedBufferGeometry` per batch: a single quad, with instanced attributes `offset` (vec3),
`scale` (vec2), `rotation` (float), `color` (vec4) and `uvRect` (vec4). Attribute uploads use
`updateRange` so only the live prefix is transferred.

Batches are keyed by (texture, blend mode, head/tail, billboard type). Blackrock's lava emitters share
a key and therefore collapse into very few draw calls.

The material is a `ShaderMaterial` reusing the existing M2 blend-mode mapping for modes 0–6, and the
fog rule established alongside this work: additive blend modes fade toward black, never toward the fog
colour, because mixing an additive contribution toward a lit fog colour adds light instead of removing
it. Billboarding is computed in the vertex shader from camera right and up vectors; the tail variant
stretches the quad along velocity.

`depthWrite` is off and `depthTest` on, with batches drawn after opaque geometry.

**Known limitation:** alpha-blended batches are sorted back-to-front *per batch*, not per particle.
Per-particle sorting would defeat the batching that makes this affordable. Additive batches need no
sorting at all, and most world emitters are additive.

### Integration and budget

`ParticleManager` lives at world level and is stepped from the existing `M2Blueprint.animate(delta)`
path, where `delta` is seconds from `THREE.Clock.getDelta()`. It owns the budget and the batches, and
parents batch meshes to a dedicated `Group` so that doodad visibility culling does not remove them.

Budget: a global `MAX_PARTICLES`, default 20 000. Each frame, emitters are ranked by camera distance
and given capacity proportional to demand until the budget is exhausted. Beyond `CULL_DISTANCE` an
emitter simulates nothing and releases its particles. This gives a predictable worst case, so a dense
area cannot starve the frame.

Lifecycle API for the creature and spell path: `createEmitters(instance)`,
`destroyEmitters(instance)`, and per-emitter `start()` / `stop()`, where stop ends emission but lets
existing particles finish rather than snapping them out of existence. Bone-bound emitters compute
their transform as `instance.matrixWorld × boneMatrix`; static doodads take an identity path.

### Suppressing the template geometry

The template quads must stop rendering. Measured on both Blackrock emitters: the geometry is
**non-indexed, 6 vertices, a single group of count 6** — so it really does draw 2 triangles. Skipping
zero-triangle submeshes would therefore not have helped. (An earlier probe reported `tris: 0` only
because it derived the count from the index buffer, which is absent here.)

An earlier version of this rule suppressed a submesh only when every texture its batches used was
also referenced by a particle emitter (texture ownership). That condition was measured to be
**unsatisfiable** and was dropped:

- `LAVASMOKEEMITTERB.M2`: model textures are `0:SMOKEWISPY02`, `1:CREATURE\GHOST\BLACK32`,
  `2:GENERICGLOW2_32`. Emitter `textureId`s are `[0, 0, 0, 2]`. `textureLookups = [1]`, and the
  model's single batch has `textureLookup = 0`, so the drawn submesh resolves to texture index
  **1** — which no emitter references.
- `LAVASPLASHPARTICLE.M2`: model textures are `0:LAVASPLASHBUBLE`, `1:Ball1`. The emitter's
  `textureId` is `[0]`. The batch resolves to index **1** again.

An emitter's particle texture and the model's renderable geometry resolve to different texture
indices in both measured cases, so texture-index comparison never fires and is not a safe premise to
reintroduce.

Suppression is instead driven by shape alone, with three conditions that must all hold. A submesh is
a particle template, and is not drawn directly, when:

1. the model has at least one particle emitter, **and**
2. the model has exactly one submesh, **and**
3. that submesh's built geometry is a single quad — 6 vertices, 2 triangles.

Condition 2 keeps ordinary multi-part doodads safe: a torch (wooden post plus flame) has several
submeshes, so it is untouched by the rule even though one of its submeshes might itself be a quad.
Condition 3 alone would be unsafe without condition 2, since some legitimate single-submesh models are
themselves one quad with no emitter. Emitters are parsed before submeshes are built, so the emitter
count is available at load time.

**Known false-positive class:** single-quad additive doodads that are not emitter templates — glow or
halo sprites, godray planes, and especially `SPELLS\*.M2` visual models, which are often one flare quad
plus spark emitters. Under the current rule, a model with a particle emitter whose *only* submesh
happens to be a single quad is suppressed even when that quad is meant to render (e.g. the flare
itself, not a template). Phase 4 routes spell M2s through this same pipeline, so such a visual would
currently render nothing at all — this is a known, accepted gap until Phase 2 removes the heuristic.

**Removing this heuristic is an exit criterion for Phase 2.** Once particles actually render, the
correct rule is "do not build geometry for submeshes the particle system owns," determined at
emitter-registration time (i.e., a submesh is claimed because a live emitter was registered against
it, not because its shape looks like a template) rather than by guessing at vertex/triangle counts.

## Delivery phases

Full fidelity is too much for one reviewable change. Each phase below leaves the tree working and
visually inspectable, and each gets its own implementation plan.

1. **Parser + template suppression.** Emitter and ribbon structs, `FBlock` decoder, layout tests. Apply
   the ownership rule so the Blackrock blobs disappear. Nothing renders yet — the visible result is the
   removal of an artifact, which is independently valuable.
2. **Core simulation and rendering.** Pool, plane and sphere emitters, integration, lifetime tracks,
   batching, material and blend modes, manager, budget allocator. This is the phase that makes fire,
   smoke and lava splashes appear. **Exit criterion: remove the Phase 1 shape-based template
   heuristic** (emitter-count + single-submesh + single-quad) once particles actually render. Replace
   it with suppression driven by emitter registration — a submesh is excluded from scene-graph
   geometry because a live particle emitter claimed it, not because its vertex/triangle counts happen
   to match a quad. This also removes the known false-positive class recorded above (single-quad
   additive doodads, and `SPELLS\*.M2` visuals in particular, since Phase 4 depends on it).
3. **Remaining emitter fidelity.** Spline and bone emitter types, tumble, drag, multi-texture, tail
   particles.
4. **Creature and spell integration.** Bone binding against animated models, runtime spawn/stop API.

Phases 3 and 4 are independent of each other and can be reordered.

## Testing

Jest, alongside the existing config:

- `fixed16` conversion and `FBlock` interpolation, including `t = 0`, `t = 1`, and out-of-range clamping.
- Emitter struct offsets against small real `.m2` files, asserting the three layout checks above.
  Fixtures are **downloaded on demand into a gitignored cache**, not committed: these are Blizzard
  files, and the whole point of this branch is that game assets live on the remote host rather than in
  the repo. Tests that need a fixture skip with an explicit message when the host is unreachable, so an
  offline checkout still passes.
- Plane emitter spawns land inside the declared emission area; sphere spawns lie within the range.
- Integration: a particle under known gravity reaches the expected position; a particle dies exactly
  at its lifespan.
- Budget allocator: never exceeds `MAX_PARTICLES`, and always releases particles from culled emitters.

Visual behaviour — whether the lava splash looks like a lava splash — stays a human judgement made
in-game.

## Out of scope

- Per-particle depth sorting.
- Particle collision with world geometry.
- A GPU simulation path. Revisit only if profiling shows the CPU step dominating.

## Notes for implementers

Shader files reached through a `#pragma glslify: import` do **not** invalidate their parent module when
edited. After touching any `.glsl` include, `rm -rf node_modules/.cache` **and restart the dev
server**, or the change is silently discarded. This has cost real debugging time twice in this
codebase.
