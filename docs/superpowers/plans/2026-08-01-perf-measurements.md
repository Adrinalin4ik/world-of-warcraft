# Perf measurements

Recorded from the in-client HUD (top-right overlay, added in Stage 0). `worst` is the metric that
matters — averages hide the hitch you feel.

Budget: **16.7 ms**. The goal is every frame under it.

> **Rows are filled by running the client.** Claude cannot take these readings; they need a real
> browser, real game data, and a real login. Run `npm start` from `client/`, stand in each location,
> and copy the HUD figures in.

## Empty / open terrain

| Stage | p50 | p99 | worst | over-budget | calls | tris |
|---|---|---|---|---|---|---|
| 0 (baseline) | | | | | | |
| 1 (overhead removed) | | | | | | |
| 2 (doodad fade cull) | | | | | | |
| 3 (portal rects) | | | | | | |

## Dense city (Stormwind)

| Stage | p50 | p99 | worst | over-budget | calls | tris |
|---|---|---|---|---|---|---|
| 0 (baseline) | | | | | | |
| 1 (overhead removed) | | | | | | |
| 2 (doodad fade cull) | | | | | | |
| 3 (portal rects) | | | | | | |

## Doodad-heavy area

| Stage | p50 | p99 | worst | over-budget | calls | tris |
|---|---|---|---|---|---|---|
| 0 (baseline) | | | | | | |
| 1 (overhead removed) | | | | | | |
| 2 (doodad fade cull) | | | | | | |
| 3 (portal rects) | | | | | | |

## Building interior (Stage 3 target)

| Stage | p50 | p99 | worst | over-budget | calls | tris | chunks |
|---|---|---|---|---|---|---|---|
| 2 (before portal rects) | | | | | | | |
| 3 (portal rects) | | | | | | | |

## Per-system CPU ms (empty terrain)

| section | Stage 0 | Stage 1 | Stage 2 | Stage 3 |
|---|---|---|---|---|
| world.animate | | | | |
| render | | | | |

## Gate decisions

### Stage 1 gate

**Stop condition:** if the empty-zone `worst` figure has not moved substantially, the model behind
the plan is wrong. Do not start Stage 2 — record what `world.animate` and `render` actually say and
re-diagnose from the attribution.

Decision: _(unfilled)_

### Stage 2 gate

If all three locations hold 60 with zero over-budget frames, stop. Note that Stage 3 remains
outstanding as a **correctness** item — portals are known broken independently of framerate — and
schedule it on that basis.

Decision: _(unfilled)_

### Stage 3 gate

If all locations hold 60 with zero over-budget frames, the goal is met and Stage 4 is unnecessary.
Otherwise record which counter is the constraint: `calls`, `tris`, a named CPU section, or `gpu`.

Decision: _(unfilled)_
