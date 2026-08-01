# Perf measurements

Recorded from the in-client HUD. `worst` is the metric that matters — averages hide the hitch you
feel. Budget: **16.7 ms**.

> **Source caveat.** The tables below are from an automated Chrome window at 1280x800 driven by a
> Playwright harness, with the camera orbiting to keep the cull pass live. The user's own machine is
> slower: their pre-fix readings showed `worst 28.5ms`, `over-budget 133/300`, `render 15.4ms`. The
> two agree on the *shape* of the problem, not the absolute numbers. Real-play figures still need to
> be taken by hand.

## After Stages 1–2 + the 0x48 exterior fix

| location | worst | p50 | p99 | over-budget | gpu | world.animate | render | calls | tris |
|---|---|---|---|---|---|---|---|---|---|
| open terrain (Duskwood) | 15.8 | 10.5 | 14.2 | 0/300 | 2.2 | 3.3 | 7.4 | 307 | 24k |
| dense city (Stormwind) | 11.3 | 6.4 | 9.8 | 0/300 | 1.2 | 6.3 | 1.8 | 103 | 15k |
| doodad-heavy (Raven Hill) | 14.8 | 10.6 | 13.3 | 0/300 | 0.6 | 9.7 | 77 | 5k | — |
| user's machine (pre-fix) | 28.5 | 16.5 | 20.3 | 133/300 | 1.7 | 3.2 | 15.4 | 178 | 37k |

## Stage 4 — constraint classification

**Verdict: CPU-bound inside `renderer.render`. Not GPU-bound, not draw-call-count bound.**

- GPU is 0.6–2.2 ms against a 16.7 ms budget — nowhere near the constraint.
- Draw calls are 77–310 and triangles 5k–37k. Both are low; merging or instancing would not help.
- The dominant cost is a single named CPU section: `render`, at 7.4–9.7 ms locally and 15.4 ms on
  the user's machine.

### Root cause, measured

`WebGLRenderer.render` calls `scene.updateMatrixWorld()` every frame
(`three.module.js:17629`), which recurses the **entire** scene graph:

- scene graph: **31,282 nodes / 17,698 meshes**
- `scene.updateMatrixWorld()`: **4.4 ms per call**, measured directly

Nearly all of those objects — terrain tiles, static doodads, WMO group geometry — are placed once
and never move again.

**A dead end worth recording:** setting `matrixWorldAutoUpdate = false` on individual static objects
does **not** help. That flag only gates the matrix multiply for that object; the child loop in
`Object3D.updateMatrixWorld` (`three.core.js:12900`) recurses unconditionally. Tried and measured:
4.38 ms → 4.86 ms, i.e. nothing. Reverted.

### The lever, measured

The renderer skips the walk entirely when `scene.matrixWorldAutoUpdate === false`. Toggled three
times at a fixed location in open terrain:

| `scene.matrixWorldAutoUpdate` | render CPU | p50 | worst |
|---|---|---|---|
| true | 8.1 ms | 11.3 | 15.2 |
| **false** | **1.9 ms** | **5.5** | **9.3** |
| true again | 9.6 ms | 11.4 | 16.7 |

Draw calls, triangles and GPU time are unchanged across all three. The saving is **~7 ms/frame,
about 42% of the budget**, and p50 halves.

### What implementing it requires

`scene.matrixWorldAutoUpdate = false` stops the walk at the root, so nothing under it updates
automatically. Every mover must then be updated explicitly each frame:

1. the player's view,
2. every entity in `World.entities` (units move independently),
3. animated doodads — skinning reads `bone.matrixWorld`, so their subtrees must still update,
4. the particle group,
5. sky/skybox objects that track the camera,
6. the camera itself (already handled: the renderer updates a parentless camera separately).

**Risk:** anything missed becomes frozen in place or invisible, and the failure is silent. This is
the same shape as the two regressions already hit in this work (the Stage 3 flood, and the 0x8
exterior test), so it needs verification that *moves* things — walking, an animated doodad, a
particle emitter — not a static screenshot.

## Gate decisions

### Stage 1 gate
Not formally recorded — the HUD was built and the overhead removed in the same pass. The Stage 4
attribution above supersedes it: `world.animate` is 3.3–6.3 ms, well clear of the budget.

### Stage 2 gate
Fade cull confirmed working and deterministic (A/B at a fixed pose: 23 → 16 visible doodads, and
identical terrain both ways). It is not the constraint; it is also not a regression source.

### Stage 3 gate
Reverted. The screen-rect flood dropped rooms; it needs near-plane polygon clipping before a retry.
See the revert commit for the full analysis.

### Stage 4 gate
Classified above. The recommended next change is `scene.matrixWorldAutoUpdate = false` plus explicit
updates for movers. Not yet implemented — it is a decision point, and the risk is real.
