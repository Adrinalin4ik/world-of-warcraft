# Collision, movement and third-person camera

**Date:** 2026-08-02
**Status:** approved design, ready for planning

Port the collision system, kinematic mover and third-person camera rig from the reference
implementation (`samples/benilla`) into this client, and get the player's own body rendering.

## Goal

A player avatar that walks, runs, jumps, falls, climbs stairs, slides off steep faces, wades into
water and swims in it the way vanilla WoW does, with a third-person camera that turns, orbits, zooms
and collides the way vanilla WoW's does — driven by the collision structures Blizzard already ships
in the game data, at a cost that does not show up in the frame budget.

Fidelity target is the reference: where `samples/benilla` records a binary-verified constant or a
named byte address for a rule, the port carries that rule and that provenance. Where the reference
made a deliberate departure (its own decision numbers), the port carries the departure and the
reason.

## Non-goals

Named so they read as decisions rather than omissions. Each drops in beside the mover later, the way
it does in the reference:

- Transports / platform frames (`PlayerRide`)
- Gait and animation selection (`player/gait.rs`, `creature_anim`)
- Remote-mover dead reckoning
- Character customisation, item slots, equipment — `displayId` stays a hardcoded constant

**Networking is explicitly deferred but explicitly prepared for.** See "Preparing for the wire".

## Why not a physics engine

The candidate approaches were: a general physics engine (rapier3d wasm), building three-mesh-bvh
BVHs over streamed world geometry, or reading the collision structures already present in the game
data. The third was chosen, on a performance argument.

A general engine spends its budget on a problem this client does not have. Its dominant cost is
building and maintaining the collision world — trimesh colliders for every terrain tile, WMO group
and doodad, created and freed as the streamer pages tiles in and out. That is a per-load spike
(acceleration-structure build over ~100k triangles per ADT tile) plus a wasm/JS boundary crossed
every frame. And it rebuilds acceleration structures the game files already contain:

| Source | Structure in the data | Present in this repo today |
|---|---|---|
| Terrain | MCVT 9×9+8×8 heightmap on a regular grid, MCNR normals | Parsed at `client/src/game/pipeline/adt/chunk/index.ts:32-67` |
| WMO | MOBN/MOBR BSP tree over collidable faces, MOPY per-triangle flags | `client/src/game/utils/bsp-tree.ts`, built per group at `client/src/game/pipeline/wmo/group/index.js:122` |
| M2 doodads | `boundingVertices` / `boundingTriangles` / `boundingNormals` — the model's own low-poly hull | Parsed at `blizzardry/src/lib/m2/index.js:147-149`; `BoundingMesh` built at `client/src/game/pipeline/m2/index.ts:174-198` |
| Liquid | ADT MH2O and WMO MLIQ — per-vertex heights on a regular grid with a per-tile filled mask | Parsed and meshed at `client/src/game/pipeline/liquid/layer.js` and `wmo-layer.js`; MLIQ struct at `client/src/wow-data-parser/wmo/group.js:116` |

The resulting cost structure:

- **Terrain height is O(1) with no acceleration structure at all.** x,y → tile → chunk → 4.1667 yd
  cell → one of four triangles → barycentric Z. Slope comes free from MCNR.
- **WMO is a BSP box query** returning a handful of leaves — tens of candidate triangles near the
  capsule, not thousands.
- **Doodads** are already-registered low-poly hulls, broadphase-culled by placement bounds.

Per frame the mover therefore sees tens of triangles. At that size the swept casts the reference's
mover is built on are a few hundred flops — cheaper than the single `Raycaster.intersectObjects`
call the current code already makes every frame.

## Current state

Collision in this client is dead code. `Unit.updatePlayer()` (`client/src/game/classes/unit.ts:609`)
is a half-finished three-mesh-bvh capsule pushout that is never called — `update()` calls
`updateMoving` + `applyTranslatePosition` instead. `ColliderManager.collidableMesh` is an empty
`THREE.Mesh` that nothing ever fills, so `updatePlayer` would return on its first line anyway.
`ColliderManager.collidableMeshList` *is* populated (terrain tiles, WMO group meshes, M2 bounding
meshes) but is a flat `Map` with no spatial structure.

`Controls` (`client/src/pages/game/controls/controls.tsx`) is a modified OrbitControls: it orbits a
target, has no collision, no look modes, and rotates the unit by the same delta it orbits the camera
by.

The player body does not render. `Player` sets `displayId = 21976` and `Unit`'s setter walks
`CreatureDisplayInfo` → `CreatureModelData` → `M2Blueprint.load`, but the result has not been seen
on screen.

## Coordinate system

The reference is Bevy: Y-up, horizontal plane XZ. This client is WoW-native: Z-up, horizontal plane
XY, `camera.up = (0,0,1)`, and `Unit.facing` is already `rotation.z`. The port is a mechanical swap,
applied consistently:

| Reference | Here |
|---|---|
| `normal1.y >= GROUND_COS` | `normal.z >= GROUND_COS` |
| `Vec3::NEG_Y * dist` | `(0, 0, -dist)` |
| `d.x.hypot(d.z)` (horizontal travel) | `Math.hypot(d.x, d.y)` |
| yaw about Y | yaw about Z |

Units need no conversion: both are WoW yards and this client is already on that scale
(`Chunk.SIZE = 33.33333` = 100/3 yd). Every constant in the reference's `player/state.rs` therefore
transfers unchanged.

## Architecture

Three new modules, each with one clear responsibility and a narrow interface.

### `client/src/game/collision/`

**`providers.ts` — the broadphase.** One interface:

```ts
interface TriangleProvider {
  gather(worldBox: THREE.Box3, layer: CollisionLayer, out: Triangle[]): void;
}
```

Three implementations:

- **`TerrainProvider`** — no acceleration structure. `worldBox` → overlapping ADT chunks →
  overlapping 4.1667 yd cells → each cell's four-triangle fan, built on demand from the `position`
  attribute already present on the chunk geometry. Typically 4–16 triangles. Respects `isHole()`:
  a hole is a real gap the player falls through.
- **`WmoProvider`** — for each loaded placement whose bounds overlap `worldBox`, transform the box
  into **model-local** space (one inverse placement matrix), call the existing `bspTree.queryBox`,
  walk the surviving leaves' faces, filter by MOPY flags for the requested layer, transform the
  survivors to world space. Transforming the query into local space rather than the geometry into
  world space is both cheaper and what the reference client does.
- **`DoodadProvider`** — the M2 `boundingVertices` / `boundingTriangles` / `boundingNormals` hull.
  Broadphase on placement bounds.

**`liquid-query.ts` — the surface query.** Liquid is *not* a collider; you do not collide with water,
you ask how deep you are in it. So this is a separate, simpler interface:

```ts
liquidAt(x: number, y: number, claim: LiquidClaim) -> { surfaceZ: number; typeId: number } | null
```

The same O(1) grid walk as the terrain provider: find the covering liquid layer, index its tile,
check the filled mask, interpolate the vertex heights. Answers for **all** liquids, not just water —
you swim in lava and slime too (Blackrock's magma, Undercity's sludge are surfaces you enter, not
ones you fall through).

`claim` scopes *which* liquid answers: inside a WMO group only that placement's own MLIQ, outdoors
only the ADT's. Without the scoping a building's floor liquid answers for someone standing outside it
and vice versa — the reference's "swim in air" defect class. This client already classifies the
camera as interior/exterior (`bspTree.checkIfInsidePortals`, the visibility manager's WMO work); the
claim reuses that classification for the player position.

**`capsule-cast.ts` — the reference's `cast_move`.**

```ts
castCapsule(from: Vec3, dir: Vec3, dist: number, layer: CollisionLayer)
  -> { distance: number; normal: Vec3; source: object } | null
```

Swept capsule-versus-triangle (segment-versus-triangle with radius) over the gathered candidate
list, returning the nearest hit. Because the list is small this is exact and non-iterative. Every
probe in the mover and the camera boom goes through this one function. Origin penetration is
ignored, matching the reference (a head grazing a surface still casts outward).

**`layers.ts` — the two collision audiences**, from the reference's `collision.rs`. The player body
and the camera collide against *different* sets of WMO faces:

- **Walk** — all faces minus MOPY `0x04` (DETAIL)
- **Camera** — all faces minus MOPY `0x02` (NOCAMCOLLIDE)

So the camera collides with visible decals and overhangs the player walks under, and passes through
NOCAMCOLLIDE faces the player still stands on. Terrain and doodads belong to both.

**`collision-world.ts`** — holds the three providers, fed by the existing streaming hooks
(`terrain-manager.js:30`, the WMO group loader, `m2/index.ts`), which already fire at exactly the
right moments. Replaces `ColliderManager`, which is deleted.

**Data-plumbing prerequisites.** Two, both small and both blocking:

1. **MOPY flags never cross the worker boundary.** MOPY is parsed
   (`blizzardry/src/lib/wmo/group.js:36`) but
   `client/src/game/pipeline/wmo/group/loader/definition.js` never copies it into `attributes`. Add
   `attributes.triangleFlags = Uint8Array(...)` alongside the existing arrays and push its buffer to
   the transferable list. Without it the two collision audiences cannot exist.

2. **`CreatureModelData.collisionHeight` is not parsed.**
   `client/src/wow-data-parser/dbc/entities/creature-model-data.js` (and the blizzardry copy) ends at
   `bloodID` followed by `skips: Reserved(uint32, 22)`. The 28-field vanilla layout puts
   `collisionWidth` at index 14 and `collisionHeight` at 15 — inside that reserved block. Replace the
   single `Reserved(22)` with `Reserved(8)` / `collisionWidth: floatle` / `collisionHeight: floatle`
   / `Reserved(12)`, which sums back to 22 so the record size is unchanged. Verify the field count
   against the DBC header at load rather than trusting the arithmetic. Every swim depth line is a
   fraction of this value, so swimming cannot be correct without it.

### `client/src/game/movement/`

- **`constants.ts`** — the reference's `state.rs` constant block, carrying its provenance comments
  (byte addresses, decision numbers, and which values are verified versus tunable). The provenance
  is the value of these numbers; without it they are unmaintainable magic constants. Includes
  `GRAVITY 19.291105`, `JUMP_SPEED 7.955547`, `TERMINAL_VELOCITY 60.148003`, `GROUND_COS 0.642788`
  (cos 50°), `GROUND_PROBE 0.2`, `LAND_PROBE 0.05`, `STEP_SLOPE_RATIO 1.849399`,
  `STEP_SNAP_SLACK 1/36`, `STEP_UP_HEIGHT 0.7`, `CAPSULE_HEIGHT 2.0277777`, `CAPSULE_RADIUS 1/3`,
  `SKIN_WIDTH 0.02`, `AIR_NUDGE_SPEED 2.5`, `WEDGE_*`, `FALL_FAR_*`, `TURN_RATE`,
  `RUN_BACK_RATIO 4.5/7.0`.

- **`mover.ts`** — the port of `mover.rs`: `step()`, `groundedStep()`, `airborneStep()`,
  `walkableRideVelocity()`, `steepWallPlane()`, `stepUp()`, `moveAndSlide()`.

  **Every one takes the cast as a parameter**, exactly as the reference does
  (`cast: &impl Fn(Vec3, Vec3) -> Option<MoveHitData>`). This is what makes the mover testable
  against synthetic planes with no world loaded.

  The behaviours ported, all of them:
  - ground classify probe (walkable iff normal within 50° of up); probe tightens to `LAND_PROBE`
    while airborne so an arc ends where the slide actually contacts
  - grounded means on walkable ground **and not rising**, so a jump cleanly leaves the ground
  - grounded moves horizontally only, with no gravity in the slide, then snaps onto the surface
  - the atomic step-up: rise by free headroom (≤ `STEP_UP_HEIGHT`) → advance this frame's travel at
    the raised height → settle onto a walkable floor; committed whole within the frame or not at all
  - `walkableRideVelocity` — a walkable slope never slows or deflects the walk; the horizontal
    velocity is preserved exactly and the vertical is recomputed to ride the plane
  - `steepWallPlane` — a steep face never lifts the mover; when the true-plane clip would convert a
    push into upward motion, the face clips as a vertical wall instead
  - the step-vs-fall election snap: reach = `travel · STEP_SLOPE_RATIO + STEP_SNAP_SLACK +
    CAPSULE_HEIGHT`, snapping only onto walkable floors; a deeper or steeper floor becomes a fall
  - airborne gravity arc with the one-shot standstill air nudge
  - wedge rest (3 consecutive stalled airborne frames → land standing)
  - FALLINGFAR latch, both legs (distance for jumps, timer for step-off falls)

  `moveAndSlide` is the one piece with no line-for-line source, because the reference delegates it
  to avian. It is: iterate up to N contacts; each time cast the remaining motion, advance to the
  hit, run the hit callback (`walkableRideVelocity` → accept, else `steepWallPlane` → rewrite the
  normal), clip velocity onto the resulting plane, repeat. The reference's callback contract defines
  its required behaviour precisely.

- **`swim.ts`** — the port of `swim.rs`. Swimming is a second movement regime the ground mover
  cannot express: when the water gets deep enough the avatar leaves the floor, floats, and swims in
  3D along its pitched facing.

  - **The enter/leave latch** (`updateSwimming`): depth = `surfaceZ − feetZ`, compared against
    `0.75 × collisionHeight` to enter (strict `>`) and `0.75 × collisionHeight − 1/36` to leave, a
    genuine hysteresis band so wading the boundary cannot flicker the regime. There is **no separate
    wade flag** — wading is the implicit in-liquid-below-threshold state, so "deepest water you can
    wade" and "shallowest water you swim in" are necessarily one number.
  - **The fraction multiplies the unit's *own* collision height**, not a constant. This is the
    reference's decision 0645 and it is load-bearing: with one human-sized constant, a gnome's rest
    line sits above her own head and she can never surface. The movement capsule stays constant;
    only the depth lines are per-unit. These are genuinely two different quantities.
  - **The vertical law**: while swimming, gravity is **bypassed entirely**. An idle swimmer's depth
    is *frozen* — no sink, no rise, no ease. The vertical comes only from the pitched travel
    velocity. There is no buoyancy spring and no resting seek.
  - **The rest line** is a hard cap at `surface − 0.75 × collisionHeight`, so a surfacing swimmer
    stops three-quarters submerged, head out. It constrains the position **both ways** and is
    re-satisfied each frame (`settleToRest`) rather than merely guarded — because the common way a
    swimmer ends up above the line is the *surface descending to meet them* on a river, which
    otherwise crosses the whole 1/36 yd hysteresis band in a fraction of a second and flaps the
    latch ~10×/s. The correction is a **swept** drop, not a position clamp: a clamp overrides
    terrain collision and pins the depth so the shore exit can never fire.
  - **The cap redirects rather than bleeds** (`capRedirect`): reaching the rest line flips a
    pitched-up stroke into full-speed *level* surface swimming, preserving speed. A plain slide
    against the cap plane leaves `cos(pitch) × speed` ≈ 0 — the "invisible wall". This one is
    flagged in the reference as its own construction (a named divergence from the disassembly,
    reproducing director-confirmed behaviour); the port carries the divergence and the note.
  - **The swim jump** (`breachStep`): Space at *any* depth clears swimming unconditionally and
    launches the walk mover's falling arc at `SWIM_JUMP_SPEED 9.096748` — at the surface it breaches
    out, submerged it is the dolphin hop. Re-entry is the depth check plus the fall gate: swim
    re-latches once upward velocity has decayed to **half** the launch value, while still rising,
    discarding the residual.
  - Speeds: `SWIM_SPEED 4.722222` (0.66× run), `SWIM_BACK_SPEED 2.5`, a net-backward swim taking
    `min(swimBack, swim)`.

  Like the mover, every function takes its world access as a parameter (the cast, and a
  `surfaceAt(pos)` closure), so the whole law is unit-testable with no world loaded.

- **`player-state.ts`** — `pos` (feet), `velZ`, `horizVel`, `faceYaw`, `modelYaw`, `airborneSince`,
  `jumpZSpeed`, `fallStartZ`, `fallFar`, `wedged`, `wedgeStill`, `settling`, `settleDeadline`,
  `swimming`, `swimPitch`, `swimStrokeSpeed`, `collisionHeight`, `levitating`.

  `collisionHeight` defaults to `DEFAULT_COLLISION_HEIGHT 2.0277777` and is replaced once the
  display id resolves — kept as a real default rather than zero-initialised precisely because at
  zero every depth line collapses to 0 and the avatar swims on dry land.

  `levitating` is server-driven and so is always `false` until the wire lands. It is included now
  because it is not an optimisation but a mechanism: while set, the water decision does **not run
  at all** — neither arm — which is what makes GM flight work and what stops dry ground clearing a
  server-granted swim on the next frame. Its absence would be a hole to re-open later.

  `faceYaw` (the aim, what the server would be told) and `modelYaw` (the rendered body heading,
  which a strafe offsets) are separate fields from the start, as they are in the reference.

**Integration.** `Unit.update()` currently calls `updateMoving` + `applyTranslatePosition`. For the
player it becomes: read input → `mover.step()` → write `view.position` and `view.rotation.z`. The
dead code goes: `updatePlayer`, `updateGravity`, `updateGroundFollow`, `updateGroundDistance`,
`groundDistanceRaycaster`, `slopeType`/`slopeAng`, the `arrow` helper, `capsuleInfo`/`tempBox`/
`tempSegment`/`tempMat`. The `position:change` emit that drives terrain streaming stays.

### `client/src/game/camera/`

**`rig.ts`**, ported from `camera.rs`:

- `CameraControl` state: `distance`, `targetDistance`, `collisionDistance`, `look`, `selfFadeAlpha`
- `runLookSession()` — right-drag turns the character (movement follows the camera heading),
  left-drag orbits the camera around a stationary character, both buttons held run forward. Includes
  the hand-off when one button releases while the other is held, and the 4 px click-versus-drag
  threshold that keeps a left *click* available for target selection. Either mode hides and locks
  the cursor (pointer lock) and restores it on release.
- `applyZoomScroll()` — 1.0 yd per notch, gliding at a **constant** 8.33 yd/s (linear,
  frame-delta-scaled — not an exponential ease).
- `seatCamera()` — pivot = `feet + pivotHeight`; ideal seat = `pivot − forward · distance`; then a
  single `castCapsule` of a 0.3 yd probe sphere **from the head, not the pivot**, out to the ideal
  seat, on the **camera** layer. Rooting the boom at the head is what stops the camera ending up on
  the far side of a ceiling mid-jump. Collision pull-in is instant (a wall must never sit between
  camera and character); push-out eases at 6/s.
- Zoom range 0…30 yd, default 15. Pitch clamp ±89.00° (1.5533430576 rad), uniform at every zoom.
- **The camera pitch drives the swim pitch.** While swimming, mouselook is a *direct set* of
  `swimPitch` from the camera aim pitch — no integrator, no rate limit, so there is zero lag and
  aiming up with the right mouse plus swimming forward is how you rise. A left-drag orbit steers
  nothing (it does not turn the character, so it must not bend the swim). `swimPitch` is **held**
  when unsteered: an idle floater keeps its pitch and is never auto-levelled. This is the one place
  the camera and the mover are genuinely coupled, so it lives in the rig's contract rather than
  being discovered later.
- A left-drag orbit offset **persists** — the vanilla `cameraSmoothStyle` auto-follow is
  deliberately not ported, matching the reference's decision.

`Controls` is rewritten as a thin input adapter: it owns DOM event listeners and pointer lock, and
feeds the rig and the mover. No camera or movement maths lives in the React component.

**Two client-side dependencies, both with working fallbacks:**

1. **Pivot height** is `(attach17.z + 0.0972) × scale` from M2 attachment id 17.
   `blizzardry/src/lib/m2/index.js:150` declares `attachments: new Nofs()` — an offset/count with no
   struct, so the data is unreachable. Needs an `M2Attachment` struct added. Until then the
   reference's own documented fallback (`0.9 × bounding-box Z extent`, floored at 5/6 yd) is used,
   so this lands as a follow-up without blocking the rig.
2. **The self-avatar fade** to first person needs a per-instance alpha channel on the M2 material.
   Whether this client's M2 materials support it is to be determined during implementation rather
   than guessed. If not, the fade degrades to a hard hide at zoom 0, which alone gives working
   first-person.

## The player body

The body is not rendering today. **The first step is diagnosis, not a fix.** The path is
`displayId = 21976` → `DBC.load("CreatureDisplayInfo", id)` → `modelID` →
`DBC.load("CreatureModelData", modelID)` → `M2Blueprint.load(file)`, and it can break at any hop:
the DBC worker, the shape of the returned `records`, MPQ path resolution, the M2 load itself, or the
model being placed but invisible. Determine which before changing anything.

Once visible:
- the body is driven by `modelYaw`, not `faceYaw`
- the `m2.rotation.z = Math.PI` fudge at `client/src/game/classes/unit.ts:226` (carrying a
  `TODO: Figure out whether this 180 degree rotation is correct`) is resolved rather than preserved
- the collider box built from the M2 bounding box in the `displayId` setter is removed; the mover's
  capsule is a constant (`CAPSULE_HEIGHT` / `CAPSULE_RADIUS`), per the reference's reasoning that
  the movement capsule is a feel knob and deliberately not the per-model collision height

## Preparing for the wire

Networking is not wired in this pass, but the design does not have to be revisited to add it. Three
concrete preparations:

1. **`faceYaw` and `modelYaw` are separate from the start.** `faceYaw` is the orientation a
   `MSG_MOVE_SET_FACING` would carry; `modelYaw` is a render concern. Collapsing them now would be
   the change that has to be undone later.

2. **`mover.step()` returns an `Outcome`**, as the reference's does: `{ held, grounded, jumped,
   airNudged, ground }`. The reference's wire layer is built entirely on this return value plus the
   state fields — the movement-flag diff, the `MSG_MOVE_JUMP` / `MSG_MOVE_FALL_LAND` transitions,
   the heartbeat. Returning it now costs nothing and is the entire integration surface.

3. **The state fields the wire needs exist and are maintained**, even though nothing reads them yet:
   `moveFlags`, `lastFacing`, `airborneSince`, `jumpZSpeed`, `fallFar`, `settling`, `swimming`,
   `swimPitch`, `swimStrokeSpeed`, `levitating`. These are not speculative additions — each is
   written by a behaviour being ported anyway (`fallFar` by the FALLINGFAR latch, `jumpZSpeed` by
   the takeoff snapshot, `swimming` by the depth latch). Leaving them out would mean removing
   working logic and putting it back later. `MOVEFLAG_SWIMMING` and its pitch tail are the swim
   regime's entire wire surface, and both are already computed.

Beyond these, `grounded_step` / `airborne_step` are exported as standalone functions for the same
reason the reference exports them: a remote mover's dead reckoning runs the identical resolve, so a
watched player meets the same walls. Nothing calls them that way yet.

## Testing

**Unit-testable, and tested:**
- The pure mover functions. The reference's own suite ports directly: a walkable ramp riding at full
  horizontal speed, a diagonal approach not being deflected, a prior facet's ride being recomputed
  rather than stacked, the walkable range covering up to the 50° gate, walking into a steep face
  clipping as a wall, the wedge-misfire window flattening, a real fall keeping the true plane,
  walkable/overhanging/vertical faces being untouched.
- `castCapsule` against synthetic triangles: hit distance and normal for head-on, grazing and
  parallel cases; miss cases; origin penetration ignored.
- Each provider's `gather` against synthetic data: terrain cell selection and hole handling, WMO
  local-space transform round-trip, MOPY layer filtering.
- The swim law. The reference's suite ports directly and is unusually valuable here because it
  encodes defects that were expensive to find: the enter/exit hysteresis at three different body
  heights; `levitating` bailing the decision in **both** directions; the latch leaving the settle
  hold alone; the hop re-latching at half launch velocity while still rising; the rest line being
  satisfied from above but never pulling up; **every race floating with its head out** (the property
  no single constant can satisfy — the gnome defect); the descending-river surface not flapping the
  latch, written as the actual frame loop that produced the bug with a real measured river slope;
  and the cap redirecting level at full speed rather than grinding.

**Not unit-testable:** feel. So the mover carries a trace hook equivalent to the reference's
`WOW_MOVE_TRACE` — one line per frame with every probe number and the step-up verdict
(`NO-HEADROOM`, `NO-FLOOR`, `STEEP-FLOOR`, `NET-ZERO`, `COMMIT`), surfaced through the existing
`DebugPanel`. The reference records that this instrument is what broke its fence and tree cases when
reasoning alone could not, which is the reason to build it up front rather than after the first
report that something feels wrong.

## Risks

- **`moveAndSlide` is the one un-ported piece.** Its behaviour is pinned by the hit-callback
  contract and by the mover tests above it, but it is where a subtle bug would hide. Mitigation: it
  is small, pure, and directly unit-tested against synthetic planes.
- **The WMO BSP query is untested at speed.** `bsp-tree.ts` exists and is used for portal and
  interior work, but not yet for per-frame collision queries. If `queryBox` proves slow, the fix is
  to cache the leaf set per placement between frames — the player moves a fraction of a yard per
  frame and the leaf set rarely changes.
- **The liquid claim depends on interior classification this client uses for rendering, not
  physics.** Scoping which room's liquid answers requires knowing which WMO group the *player* is
  in; today the equivalent classification is done for the camera. If reusing it proves awkward, the
  fallback is ADT-only liquid, which is correct outdoors (where nearly all swimming happens) and
  wrong inside flooded buildings — a bounded, visible failure rather than a subtle one.
- **Terrain provider correctness depends on chunk indexing.** The mirrored axes in
  `adt/chunk/index.ts` (`position.y = adt.y - indexX * size`, `position.x = adt.x - indexY * size`)
  must be reproduced exactly by the height lookup. Mitigation: the provider derives triangles from
  the same geometry buffer the renderer draws, rather than re-deriving positions from MCVT
  independently.
