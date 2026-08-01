# Renderer optimization: a constant 60 fps

**Date:** 2026-08-01
**Status:** Approved design, pending implementation plan

## Goal

Hold 60 fps — a **16.7 ms frame budget with no frame over it** — in the three places the client
currently fails: open terrain (everywhere, even empty zones), dense cities (Stormwind, Orgrimmar),
and any area thick with M2 doodads.

"Constant" is the operative word. The success metric is **worst frame ms over a rolling window**,
not average fps. An average hides the hitch a player actually feels.

## Reference

`samples/benilla` is a from-scratch Rust/Bevy 1.12.1 client whose culling and fade laws are
re-derived from `WoW.exe` build 5875 with cited byte offsets. Where it has a law, we port that law
rather than inventing an approximation. The four modules this design draws on:

- `crates/benilla/src/perf.rs` — the frame-measurement standard (p50/p99/worst, budget line).
- `crates/benilla/src/model_fade.rs` — the size-bucketed world-doodad distance fade.
- `crates/benilla/src/wmo_portal/mod.rs` — the portal flood as a narrowing 2-D screen rect.
- `crates/benilla/src/exterior_cull.rs` — the deferred-window exterior pass.

## Approach

Four staged changes behind a measurement gate, each with recorded before/after numbers. The two
failure modes have different causes — open terrain implicates fixed per-frame overhead, cities and
doodads implicate scene complexity — and staging is what separates them instead of guessing. Any
stage may be stopped at if 60 is already held.

---

## Stage 0 — Perf HUD

New module `client/src/game/perf/`. It lives **outside React's render path**, writing directly into
a fixed overlay div at ~4 Hz. This is not incidental: the existing debug panel re-renders through
React every frame and is itself part of the problem being measured.

### Components

**`FrameStats`** — a 300-sample ring buffer of frame durations (~5 s at 60 fps). Exposes p50, p99,
and worst, plus a count of frames exceeding the 16.7 ms budget. Worst-frame is the headline figure.

**`CpuSections`** — named `performance.now()` spans around the hot calls, giving per-system
attribution: `locateCamera`, `updateVisibility`, `updateAllMaterialsWithLight`, `animate`,
`particles`, `renderer.render`. This is what decides which stage matters next.

**`GpuTimer`** — `EXT_disjoint_timer_query_webgl2` around the render call, so CPU-bound vs
GPU-bound is measured rather than assumed. Where the extension is unavailable the readout shows
`n/a`; it never blocks or falls back to a fabricated number.

**Scene counters** — `renderer.info.render.calls`, `.triangles`, `renderer.info.programs.length`,
`renderer.info.memory.geometries` / `.textures`, and the visible-object counts already tracked by
`VisibilityManager.stats` (chunks, WMO groups, doodads).

### Constraint

The HUD must not appear in its own measurements at more than negligible cost. Sampling is per
frame (cheap counter reads and `performance.now()` deltas); DOM writes are throttled to 4 Hz.

---

## Stage 1 — Fixed per-frame overhead

The stage expected to explain "open terrain everywhere."

1. **`client/src/pages/game/index.tsx:152`** — remove the per-frame `this.forceUpdate()`. React
   state on this component (`renderer`, `composer`) is assigned once at mount; nothing requires a
   60 Hz re-render of the tree.
2. **`client/src/pages/game/index.tsx:180`** — `debugPanel.current.forceUpdate()` moves to the
   HUD's 4 Hz cadence.
3. **`client/src/game/world/map.js:293`** — `updateAllMaterialsWithLight` currently calls
   `this.traverse()` across the entire scene graph and every material on it, every frame. Replace
   with a **material registry**: a flat `Set<Material>` that managers add to as materials are
   created or adopted; the per-frame pass iterates only that set and pushes uniforms.

   The zone-change staleness fix documented at `map.js:246-273` must be preserved. M2 materials are
   cached and shared across placements and maps, while `changeMap` swaps in a fresh `MapLight` per
   zone; a truthiness check would leave a shared prop bound to a dead `MapLight` whose fog and
   time-of-day are frozen. The registry keeps the same `!==` comparison against the current
   `MapLight`, with a generation bumped on `changeMap` — identical semantics, without walking the
   graph.
4. **`client/src/game/pipeline/wmo/portal/index.ts:45`** — remove the `setInterval` created per
   portal. It reassigns a colour on a material whose `visible` is `false`, and it is never cleared,
   so live timers accumulate for the session, one per portal.
5. **Allocation churn in the cull pass** — `new THREE.Frustum()` and `new THREE.Matrix4()` per
   frame (`visibility-manager.js:49`, `:58`), a `.clone()` per portal vertex per frame
   (`portal/view.js:99`, `:166`), and the camera `.clone()` pair (`index.tsx:211-212`) all become
   preallocated scratch objects reused across frames.

### Gate

Record p50 / p99 / worst in an empty zone before and after. If the empty-zone number does not move
substantially, the model behind this design is wrong; stop and re-derive from the `CpuSections`
attribution before starting Stage 2.

---

## Stage 2 — Doodad distance law and cull restructure

### The law

Ported from `model_fade.rs`, which cites verified operand bytes in `WoW.exe`: radius cutoffs at
`0x810188` / `0x81018c` / `0x810190`, band ends at `0x8101a0`/`a4`/`a8`, ranges at
`0x810194`/`98`/`9c`.

Per doodad: `d = horizontal_distance(center.xy, camera.xy) − boundingRadius`. The band is selected
**purely by the doodad's bounding-sphere radius**:

| bounding radius | fade band (start → end, yd) | examples |
|---|---|---|
| `> 7.0` | never fades | trees, buildings — drawn to the frustum far clip |
| `<= 0.5` | 40 → 50 | fences, haystacks, small props |
| `0.5 – 2.5` | 100 → 125 | mid props |
| `2.5 – 7.0` | 150 → 200 | large props |

`fade = 1 − (d − start) / range`, clamped to `[0, 1]`.

- `fade <= 0` ⇒ **the doodad is not drawn**. This is the performance win, and the one that targets
  doodad-heavy areas.
- `0 < fade < 1` ⇒ the scalar reaches the batch as per-vertex `diffuse.a`, producing a soft
  gradient instead of a pop. Fidelity rather than performance, but it is the same law and ships
  with it.

Radius is a bounding sphere computed over the existing `boundingVertices`
(`client/src/game/pipeline/m2/index.ts:146`), multiplied by the placement scale applied in
`DoodadManager.placeDoodad`.

### Cull restructure

`VisibilityManager.update` currently runs four full sweeps writing `visible = false` over every
loaded object (`visibility-manager.js:31-34`), then a second set of sweeps that test and re-enable.
Every loaded object is touched at least twice per frame before any culling decision exists. This
collapses into a single pass that computes a verdict per object and writes `visible` once.

### Stale bounding-box fix

`worldBoundingBox` is computed on first use and cached forever
(`visibility-manager.js:117`, `:165`), with no invalidation. Any object that moves after its first
culled frame is thereafter tested against a stale box. The cache gains invalidation keyed on the
object's world matrix.

---

## Stage 3 — Portal flood as screen rects, and exterior windows

Replaces the plane-frustum projection in `client/src/game/pipeline/wmo/portal/view.js` with the
mechanism the reference client uses (`wmo_portal/mod.rs`, marked VERIFIED against the 5875 binary).
This is a correctness fix as much as a performance one — portals are known not to work today.

### The flood

The working frustum is a **2-D NDC rect**, not a set of planes. Per portal:

1. Test the camera is on the portal's front side.
2. Project the portal polygon to clip space and take its screen-space AABB.
3. Intersect that rect with the incoming rect.
4. Recurse into the neighbour group with the narrowed rect.

A branch terminates the moment the rect collapses below the zero-area epsilon in either axis. That
collapse is the mechanism that culls the Stormwind cathedral from the Trade District while still
drawing it from the gates; the current plane-based code has no equivalent.

### Epsilons

Carried verbatim from the client, not normalized to "sensible" tolerances. Changing any of them
requires re-deriving from the binary first.

- On-plane band: `0.01` (eye within this of the plane and inside the polygon ⇒ full-screen rect).
- `w`-clamp band: `0.001`, strict `<`.
- `w` substitute: `1e-5`, **positive regardless of the vertex's sign** — a vertex with
  `w <= -0.001` is not clamped and divides by its real negative `w`.
- Rect-collapse minimum NDC extent: `0.001`.
- Ray/plane near-parallel threshold: `1e-4`.
- Eye-embedded-in-plane snap window: `0.1` yd.

### Exterior windows

From `exterior_cull.rs`: standing inside a WMO, the outdoor world is drawn **once per leftover
portal window**, with the frustum narrowed to that window's rect — and **zero windows means no
exterior content is drawn at all**.

Today `visibility-manager.js:86` sets `map.exterior.visible = true` on any exterior reach and then
walks every map doodad and every chunk. A sealed room pays for the entire outdoor scene.

Each window's sub-frustum is built as `rectToNdc * projectionMatrix * matrixWorldInverse` fed to
`THREE.Frustum.setFromProjectionMatrix`, which extracts the identical 6 planes — an NDC rect is a
scale-and-offset on clip space. This keeps one plane-extraction implementation rather than a
hand-rolled corner-ray port.

Windows narrower than the rect-collapse epsilon in either axis are dropped.

### Current-group seed

The camera's starting group becomes a **seed set** rather than a single group: a downward raycast
producing in-group and across-group seeds, each flooded as an independent root
(`wmo_portal/seed.rs`). Walking-collision faces race portal crossings under the eye, which is why
the reference treats the verdict as a set.

---

## Stage 4 — Draw-call reduction (conditional)

Entered only if the HUD shows the budget still missed after Stages 1–3, and aimed only at whichever
counter the HUD identifies. Deliberately unspecified here — writing it now would be guessing ahead
of data. Candidates in the order they would be measured:

- Merging ADT MCNK chunk meshes per tile. `CHUNK_RENDER_RADIUS = 10` (`settings.ts:4`) with
  `CHUNKS_PER_ROW = 64 * 16` means roughly 441 separate chunk meshes resident.
- Routing repeated doodads through the existing `client/src/game/pipeline/m2/batch-manager.js`.
- Material and shader-program deduplication.
- Front-to-back sorting of opaque draws.

The implementation plan will treat Stage 4 as a decision point requiring fresh measurement, not a
pre-committed work item.

---

## Testing

Extractable laws get unit tests alongside the existing `__tests__` convention in each pipeline
directory:

- Fade band selection and radius bucketing, including the exact cutoff boundaries (0.5, 2.5, 7.0)
  and the clamp at both ends.
- NDC rect intersection and collapse detection at the `0.001` epsilon.
- The `w`-clamp sign asymmetry: `w` in `(-0.001, 0.001)` substitutes `+1e-5`; `w <= -0.001` does
  not.
- Seed-set generation from a down-ray crossing a portal plane, including the near-parallel snap.
- The bounding-box cache re-tests an object after its world matrix changes.

Performance itself is gated manually on HUD numbers. Each stage in the implementation plan carries
explicit before/after fields for p50, p99, worst, over-budget count, draw calls, and triangles,
recorded in three locations: an empty zone, a dense city, and a doodad-heavy area.

## Out of scope

- Anything outside the render and visibility path (networking, UI, asset loading).
- Invented LOD schemes or tuned-by-eye distance thresholds. Where the reference has a law, that law
  is ported; where it does not, the change is mechanical and visually neutral.
- Stage 4 specifics, pending Stage 1–3 measurements.
