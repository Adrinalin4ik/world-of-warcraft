# M2 Animation — Design

**Date:** 2026-08-04
**Status:** Design approved, spec under review
**Scope:** Animate every animated object in the world — terrain doodads, WMO doodads, units, texture/UV
and colour channels — including external `.anim` sequences.

---

## 1. Problem

Nothing in the world animates. The animation system is fully built and completely inert.

[`animation-manager.js:165-175`](../../../client/src/game/pipeline/m2/animation-manager.js) — both branches
of `registerTrack` are commented out:

```js
registerTrack(opts) {
  let trackID;
  if (opts.animationBlock.globalSequenceID > -1) {
    // trackID = this.registerSequenceTrack(opts);
  } else {
    // trackID = this.registerAnimationTrack(opts);
  }
  return trackID;
}
```

`registerAnimationTrack` and `registerSequenceTrack` are intact below it. Eight call sites feed them —
bone translation/rotation/scale in [`m2/index.ts:256-294`](../../../client/src/game/pipeline/m2/index.ts),
plus UV, transparency and vertex-colour blocks at
[`m2/index.ts:591-660`](../../../client/src/game/pipeline/m2/index.ts). Every `AnimationClip` is therefore
created empty, `mixer.update()` runs each frame over nothing, and every skeleton holds its bind pose.

The three material subscriptions that would push animated values into uniforms are commented out too —
[`material/index.ts:512, 532, 554`](../../../client/src/game/pipeline/m2/material/index.ts).

Two further gaps sit on top:

- **WMO doodads never ask to play.**
  [`wmo/index.js:266-274`](../../../client/src/game/pipeline/wmo/index.js) is commented out, while terrain
  doodads do call `playAnimation(0)` in
  [`doodad-manager.js:144-155`](../../../client/src/game/world/doodad-manager.js).
- **External `.anim` files are unsupported.** No parser, no fetch. The guard at
  [`animation-manager.js:186`](../../../client/src/game/pipeline/m2/animation-manager.js) exists because
  those sequences parse as empty.

### 1.1 Root cause — why it was switched off

Instances share one `AnimationManager` but each builds its own bones.
[`m2/index.ts:121-137`](../../../client/src/game/pipeline/m2/index.ts) assigns `instance.animationManager`
from the source M2, then calls `createSkeleton()`, which constructs fresh `THREE.Bone` objects and
registers tracks named `bone.uuid + '.position'` into that **shared** manager.

So the 200th torch appends its own three tracks per bone to the same clips the other 199 already did. One
`AnimationClip` accumulates tens of thousands of tracks, each re-bound and evaluated per frame by
`mixer.update()`.

This is not a bug in the wiring — it is the binding model. `THREE.AnimationMixer` binds by
object-property string path, which forces per-instance track duplication for what should be per-model
shared keyframe data. Re-enabling `registerTrack` cannot fix it.

---

## 2. References and their limits

**[benilla](../../../samples/benilla)** — a from-scratch 1.12.1 client in Rust, byte-verified against the
kernel. The primary reference for *semantics*.

**[WebWoWViewer](../../../WebWoWViewer)** — a WebGL 3.3.5 viewer. The reference for the *runtime shape*
([`animationManager.js:157`](../../../WebWoWViewer/js/application/angular/wowRenderJs/manager/animationManager.js)):
per-instance clocks, shared model data, results written into caller-supplied arrays.

### 2.1 The version caveat

**Benilla targets 1.12.1; this project targets 3.3.5a.** Their `M2Track`
([`track.rs:16-36`](../../../samples/benilla/crates/benilla-m2/src/track.rs)) is the vanilla layout — one
absolute key list plus a per-sequence `ranges: Vec<(u32,u32)>` index window. WotLK already splits keys into
per-sequence arrays; that is the `Nofs(Nofs(...))` in
[`animation-block.js:9-10`](../../../blizzardry/src/lib/m2/animation-block.js).

**Therefore:** benilla's `sample_window`, its `ranges` bracket logic, and the whole per-band bake in
[`key_anim.rs`](../../../samples/benilla/crates/benilla-formats/src/models/key_anim.rs) solve a problem
WotLK does not have. **Port the semantics; do not port the bake mechanics.**

Vanilla also has no external `.anim` files, so benilla is silent on §6. WebWoWViewer is the reference there.

---

## 3. Architecture

Delete [`animation-manager.js`](../../../client/src/game/pipeline/m2/animation-manager.js) and the
`THREE.AnimationMixer` path. Add `client/src/game/pipeline/m2/anim/`, four modules, each testable alone —
the shape [`m2/particle/`](../../../client/src/game/pipeline/m2/particle) already established.

### 3.1 `tracks.ts` — the sampler

One function per value type (scalar, vec3, quaternion), each taking a WotLK per-sequence key array
directly. Quaternion keys arrive as `compfixed16array4`
([`wow-data-parser/m2/index.js:36`](../../../client/src/wow-data-parser/m2/index.js)), so decompression
lives here.

The sampling law, ported verbatim from
[`KeyAnim::sample_or`](../../../samples/benilla/crates/benilla-formats/src/models/key_anim.rs):

| Rule | Benilla source | Why |
|---|---|---|
| `interp == 0` ⇒ step; hold each key | `key_anim.rs:73` | Existing `evaluateAnimationTrack` always lerps — blinking eyes and flipbook cells smear |
| `k0` = last key ≤ t; past the final key, **hold** | `key_anim.rs:113-126` | No wrap-lerp back toward key 0 |
| Interpolation fraction clamped to `[0,1]` | `key_anim.rs:177` | Deliberate deviation from the kernel: an extrapolated negative alpha culls a batch on a data quirk |
| Quaternions slerp, never component-lerp | — | Component lerp visibly shortens limbs mid-swing |

**The clock law is data, not a caller decision.** Each channel resolves to wrap or clamp at build time
([`key_anim.rs:74-88`](../../../samples/benilla/crates/benilla-formats/src/models/key_anim.rs)):

- global-sequence track (`globalSequenceID > -1`) → **always wrap** — its own free clock, the same loop in
  every animation;
- sequence track → wrap iff the sequence loops; **clamp iff one-shot**.

Backwards, this is not subtle: a Death sequence fades every batch to alpha 0, then one frame later snaps
back to a fully opaque corpse frozen mid-air, permanently.

### 3.2 `model-anim.ts` — per-model, immutable

Built **once per model path** in the [`M2Blueprint`](../../../client/src/game/pipeline/m2/blueprint.js)
cache. Keyframes exist once regardless of placement count. This is the whole fix for §1.1.

Holds:

- the sequence table, straight off the already-parsed `Animation` struct
  ([`wow-data-parser/m2/index.js:9-25`](../../../client/src/wow-data-parser/m2/index.js)): `id`, `subID`,
  `length`, `flags`, `probability`, `blendTime`, `movementSpeed`, `nextAnimationID`, `alias`;
- global-sequence durations;
- parent-ordered bone indices, per-bone billboard kind, and the `0x04` ignore-parent-rotation flag
  ([`anim.rs:24-31`](../../../samples/benilla/crates/benilla-formats/src/models/anim.rs));
- which channels are animated at all;
- **`pickVariation(animId, roll)`** — frequency-weighted over `probability`, grouped by `subID`; port of
  [`pick_variation`](../../../samples/benilla/crates/benilla-assets/src/model/anims.rs);
- **`resolve(requested)`** — the `alias` / `nextAnimationID` fallback chain; port of
  [`resolve`](../../../samples/benilla/crates/benilla-assets/src/model/anims.rs);
- **`classify(model)`** — does this model animate anything at all?

### 3.3 `instance-anim.ts` — per-placement, mutable, small

`currentAnimationIndex`, `armedAt`, blend state, and its own output buffers (bone palette, texture
matrices, submesh colours, transparencies).

Note it holds **no** global-sequence clock. A global sequence is a pure function of world time and cannot
differ between instances, so it lives on `model-anim.ts` — see §5.1 item 3. This is a deliberate divergence
from WebWoWViewer, which keeps `globalSequenceTimes` per instance.

Sampling is **clock-indexed, not delta-accumulated**: `cursor = clock − armedAt`
([`doodad_anim.rs:14-16`](../../../samples/benilla/crates/benilla/src/doodad_anim.rs)). A paused offscreen
instance therefore costs nothing and drifts nothing; resuming seeks to `(now − armedAt) mod duration`
rather than popping. **This property is what makes §5 gating safe** — it is a load-bearing design
decision, not an implementation detail.

Bone evaluation keeps WebWoWViewer's lazy parent-first walk with a `bonesIsCalculated` flag array: a bone
solves at most once per frame however many children request it, and unanimated branches cost nothing.

### 3.4 `variation-cycle.ts` — the doodad arming host

A doodad is **not** "animation 0 on loop". Per
[`doodad_anim.rs:4-9`](../../../samples/benilla/crates/benilla/src/doodad_anim.rs) it is armed at bone 0 /
animation id 0 / `linkFlag=1`, then **re-arms itself at every play-window boundary, for ever**, rolling a
fresh frequency-weighted variation each time. Global sequences run underneath with no arming at all.

**De-sync comes from one shared RNG stream drawn consecutively — explicitly not a per-placement seed.**
Benilla shipped a position hash first; it de-synced correctly but *permanently*, so the Blasted Lands
lightning struck from one fixed spot every session
([`doodad_anim.rs:37-45`](../../../samples/benilla/crates/benilla/src/doodad_anim.rs)).

**Two gates, deliberately different**
([`doodad_anim.rs:20-25`](../../../samples/benilla/crates/benilla/src/doodad_anim.rs)): the **draw** gates
the pose; **residency** gates the variation cycle. A doodad behind the camera keeps cycling variations but
stops posing.

### 3.5 Ownership summary

One `model-anim.ts` per model path; one `instance-anim.ts` per animated placement; zero per-placement
keyframe data. 200 torches share one keyframe set and hold 200 small structs — against today's ~600
duplicated tracks each, in one shared clip.

---

## 4. Data flow to the GPU

### 4.1 Bone palettes

**Multi-bone** animated submeshes keep `THREE.SkinnedMesh` and the existing bind-pose handling in
[`bind-pose.ts`](../../../client/src/game/pipeline/m2/bind-pose.ts) — that file documents two failure modes
already paid for (identity bone inverses, and `bind()` recomputing inverses after the bones left model
space) and neither is revisited here. The evaluator writes into `skeleton.boneMatrices` directly and flags
the bone texture for upload; posed instances only.

**Single-bone** animated submeshes take neither — see §5.1 item 2. The evaluator writes the one bone's
matrix into the submesh's local transform and the submesh draws as a plain `THREE.Mesh`, with no skinning
shader, no skeleton and no bone texture.

### 4.2 Shared materials

M2 materials are cached and shared across every placement
([`submesh.js:9-13`](../../../client/src/game/pipeline/m2/submesh.js)). Per-instance UV matrices,
transparency and vertex colour therefore **cannot** be written from a per-doodad loop — whichever placement
wrote last would win for all of them.

They are pushed at draw time in `onBeforeRender`. The precedent is in the same file:
[`applyFadeAlphaBeforeRender`, `submesh.js:18-29`](../../../client/src/game/pipeline/m2/submesh.js), which
solves this exact problem for distance-fade alpha. The three commented-out subscriptions in
[`material/index.ts`](../../../client/src/game/pipeline/m2/material/index.ts) are deleted, not restored —
the subscription model is what was wrong.

This is also a performance win: culled batches never pay for the write.

---

## 5. Frame budget

[`renderer-60fps-optimization.md:13`](../plans/2026-08-01-renderer-60fps-optimization.md) sets the rule:
**16.666 ms, headline metric is worst frame over a rolling window, never average fps.**

**Acceptance gate: the `anim` CPU section holds ≤ 2 ms, and worst-frame is unchanged versus the current
static build**, measured in Stormwind and in open terrain. If it cannot hold that, gating tightens rather
than the feature shipping over budget.

**Task 1 of implementation is the instrument, before any evaluator code**: a `sections.begin('anim')` span
on [`PerfMonitor`](../../../client/src/game/perf/index.ts) plus counters for instances resident / posed /
skipped, bones solved, and palette uploads. Every item below is then a measured delta.

### 5.1 Structural — the work never happens

1. **`classify` at load.** ~90% of placed doodads animate no channel
   ([`doodad_anim.rs:17-19`](../../../samples/benilla/crates/benilla/src/doodad_anim.rs), measured). Those
   allocate no instance and never enter the loop. Largest single win.
2. **Per-submesh skinning instead of per-model.**
   [`m2/index.ts:104`](../../../client/src/game/pipeline/m2/index.ts) sets `useSkinning` model-globally —
   one animated bone forces *every* submesh onto `SkinnedMesh`, a skinning shader and a bone texture. Most
   animated doodad submeshes ride exactly one bone (a flag, a blade, a sign): write that bone's matrix into
   the submesh's local transform and draw a plain `THREE.Mesh`.
3. **Global sequences evaluate once per model.** A global sequence is a pure function of world time, so
   every instance computes an identical result. Hoist to `model-anim.ts`. A courtyard of a hundred braziers
   evaluates its glow pulse once. *(Deliberate divergence from WebWoWViewer, which keeps
   `globalSequenceTimes` per instance — state that provably cannot differ.)*
4. **Drop the per-animated-doodad `updateMatrixWorld(true)`.**
   [`world/index.ts:415-430`](../../../client/src/game/world/index.ts) forces a full recursive subtree walk
   per animated doodad per frame. The evaluator computes bone world matrices parent-first as its actual
   job; three.js re-walking the same hierarchy is duplicated work.
5. **No allocation in the hot loop.**
   [`m2/index.ts:604`](../../../client/src/game/pipeline/m2/index.ts) does `new THREE.Matrix4()` per UV
   animation per update — per-frame garbage, and GC pauses land on the worst-frame metric. Preallocate all
   temporaries; write in place.

### 5.2 Gating — bounded work per frame

6. **Draw gates the pose.** Reuse the visibility verdict Stages 2–3 of the 60fps plan built (far clip,
   size-bucketed distance fade, portal cull). Safe because of §3.3's clock-indexed sampling.
7. **Distance-decimated update rate, phase-staggered.** Near every frame, mid every 2nd, far every 4th,
   holding the previous palette between. **The stagger matters more than the decimation** — bucket by
   instance id modulo the period. Naive decimation synchronises every instance onto one frame and creates
   the spike it was meant to prevent.
8. **Hard per-frame bone-evaluation cap, priority-ordered by screen size.** Overflow instances hold last
   frame's pose. This is what protects the worst-frame number: rounding a corner into a dense city is
   exactly when the count jumps and exactly when an average-based scheme fails.
9. **Blending capped to near instances.** A cross-fade evaluates two poses
   ([`blendMatrices`](../../../WebWoWViewer/js/application/angular/wowRenderJs/manager/animationManager.js)),
   doubling cost during transitions. Far instances snap — invisible at distance, and it stops a wave of
   simultaneous transitions blowing item 8's cap.

### 5.3 Risk

Items 1–5 are strict removals of work and should measure as a win before any gating exists. Items 6–8 are
where this can still go wrong, and they are unfalsifiable without the HUD — which is why the instrument
lands first and why item 8 exists as a backstop.

---

## 6. External `.anim` files

Sequences whose data lives outside the `.m2` are currently skipped by the `flags & 0x130` guard at
[`animation-manager.js:186`](../../../client/src/game/pipeline/m2/animation-manager.js). In 3.3.5 the
low-index sequences (Stand, most ambient doodad loops) are inline; a large share of creature locomotion and
combat is external.

**No asset-pipeline change is needed.** [`loader.js:21-36`](../../../client/src/game/net/loader.js) serves
any path from the extracted tree, so a sibling `.anim` is another `loader.load()`.

- **Naming and layout must be confirmed against real data during implementation**, not assumed from this
  spec. The implementation plan's first `.anim` task is a probe that dumps one known creature's external
  sequence and verifies the parse against its inline sequences.
- Fetch is **lazy, cached per model path, and never on the frame path** — parsed in the existing
  [worker pool](../../../client/src/game/pipeline/worker/pool.js).
- Until a fetch resolves, the model plays its inline sequences. A failed fetch is not an error state: the
  model keeps its inline sequences and logs once per path.

---

## 7. Call sites to re-enable

- [`doodad-manager.js:144-155`](../../../client/src/game/world/doodad-manager.js) — replace
  `playAnimation(0)` + `playAllSequences()` with the §3.4 arming host.
- [`wmo/index.js:266-274`](../../../client/src/game/pipeline/wmo/index.js) — uncomment and route through
  the same host. WMO doodads animate identically to terrain doodads; the split exists only because the code
  was disabled at different times.
- [`unit.ts:296-337`](../../../client/src/game/classes/unit.ts) — units resolve through
  `model-anim.ts#resolve` rather than a raw index, so a missing sequence falls back rather than freezing.
- [`world/index.ts:433-459`](../../../client/src/game/world/index.ts) `animateEntities` and
  [`blueprint.js:91-98`](../../../client/src/game/pipeline/m2/blueprint.js) `M2Blueprint.animate` — both
  currently drive `animationManager.update(delta)`; both move to the evaluator.

---

## 8. Testing

Pure modules, tested directly — following [`m2/particle/__tests__/`](../../../client/src/game/pipeline/m2/particle/__tests__).

- **`tracks.ts`** — one test per row of the §3.1 table. Step vs linear; hold past the final key (explicitly
  asserting *no* wrap-lerp); fraction clamping on an out-of-bracket time; slerp vs component-lerp on a
  90° quaternion pair; fixed16 decompression against known values.
- **Clock law** — a looping sequence wraps; a one-shot sequence clamps and **holds its tail**, asserted as
  the alpha-0 Death case from §3.1 rather than as an abstract boundary.
- **`model-anim.ts`** — `pickVariation` weighting distribution over a fixed roll sequence; `resolve`
  following `alias` and `nextAnimationID`, including a cycle guard; `classify` returning false for a model
  with no animated channel.
- **`instance-anim.ts`** — clock-indexed resume: pose after `pause → advance clock → resume` equals the
  pose of an instance that never paused. This is the property §5.2 gating depends on and it must be a test,
  not an argument.
- **Gating** — decimation phase stagger spreads updates across frames rather than aligning them; the
  bone-cap holds the previous pose instead of skipping a draw.
- **Manual** — the perf HUD in Stormwind and open terrain against §5's gate. Automated tests cannot cover
  the acceptance criterion.

---

## 9. Out of scope

- Animation-driven sound events (`$SND`, footsteps) — benilla has
  [`sound/anim_events.rs`](../../../samples/benilla/crates/benilla/src/sound/anim_events.rs); a later spec.
- Per-arm and upper-body masked animation blends
  ([`anims.rs` `arm_nodes`](../../../samples/benilla/crates/benilla-assets/src/model/anims.rs)) — needs
  equipment and combat state this project does not have yet.
- Animation-driven bounds for mouse picking and blob shadows.
- Ribbon emitters.
