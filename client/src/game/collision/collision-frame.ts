/**
 * **THE COLLISION EPOCH: one world-matrix refresh per placement per FRAME, not per cast.**
 *
 * Shared by the doodad and WMO providers, which have the same one-time ordering problem and had the
 * same per-cast cost because of it. It lives in its own module because it belongs to the collision
 * FRAME rather than to either provider -- `beginCollisionFrame` was in `doodad-provider.ts` while
 * only that provider used it, and a second consumer is the point at which that stops being honest.
 *
 * ## Why a refresh exists at all
 *
 * A placement is registered with its provider when its geometry is CONSTRUCTED, which is BEFORE the
 * placement transform is written, and the map subtree is declared static (`world/map.js:39`,
 * `isStaticSubtree = true`) so `World#updateDynamicMatrices` deliberately never walks it. Nothing
 * else would ever fix a stale identity matrix, and a stale identity matrix puts the bounds at the
 * world origin, where the query box never reaches them -- so the placement silently never collides.
 * Measured, before the refresh was added: **2528 map doodads loaded, zero triangles gathered.**
 *
 * So a refresh is needed exactly ONCE, after placement -- never per frame, and never per cast.
 *
 * ## What it cost per cast
 *
 * `updateWorldMatrix(true, false)`'s `true` makes it recurse UP the parent chain, re-composing every
 * ancestor's `matrixWorld` on the way down to the leaf. Called per registered placement per gather,
 * and every provider's `gather` walks its whole registry, that is thousands of ancestor-chain walks
 * a frame -- paid to reject placements that return a handful of candidates. It also undoes a saving
 * this project already banked: `scene.matrixWorldAutoUpdate = false` took the render section from
 * 8.1 ms to 1.9 ms precisely by not walking static nodes every frame (`CLAUDE.md`), and this walked
 * them from the collision path instead.
 *
 * The measured arc on `ctl.move` from removing it in both providers: **4.23 -> 3.28 -> 2.48 ms**,
 * none of it from touching the sweep.
 *
 * ## Defaults to the old behaviour
 *
 * `epoch` starts at 0 and every provider's `refreshedIn` starts at 0, and both providers disable the
 * skip outright while `epoch === 0`. So a caller that never calls `beginCollisionFrame` -- every
 * collision unit test -- refreshes on every gather exactly as before, and the optimisation is opt-in
 * by the app, which keeps the risk on the side that has an owner to check it.
 *
 * (That guard is not decoration: without the `epoch === 0` case, a cache entry stamped with the
 * never-begun epoch 0 compared equal for ever and the refresh was skipped permanently. It was caught
 * by an existing gate test.)
 */
let epoch = 0;

/**
 * Open a new collision frame: every registered placement will refresh its world matrix once more.
 *
 * Called from `Controls#update` before any cast is issued. Bumping it more often than once a frame
 * is safe (it only costs the refreshes back); bumping it LESS often is not, and is why this is not
 * driven off the movement census, which is stamped after the mover has already cast.
 */
export function beginCollisionFrame(): void {
  epoch += 1;
}

/** The current epoch. `0` means no frame has ever been begun -- see the note above. */
export function collisionEpoch(): number {
  return epoch;
}

/**
 * 16 floats, compared exactly. No epsilon: the question is "is this the same matrix", not "is it
 * close" -- a near-equal matrix is a placement that moved slightly, and its collision must move
 * with it.
 */
export function matrixElementsEqual(cached: ArrayLike<number>, elements: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; ++i) {
    if (cached[i] !== elements[i]) {
      return false;
    }
  }
  return true;
}

/**
 * **HAS THIS PLACEMENT SETTLED?** Two conditions, and both are needed.
 *
 * ## Why "non-identity AND unchanged" and not either alone
 *
 * "Unchanged since the last refresh" ALONE is unsafe, and this is the trap: an UNPLACED node's
 * matrix is also unchanged between frames, so settling on stability would latch the identity matrix
 * before placement ever happened -- which is precisely the recorded failure the refresh exists to
 * prevent ("2528 map doodads loaded, zero triangles gathered"). It has to be shown that placement
 * HAS occurred, and a non-zero translation is that evidence: every map placement sits thousands of
 * yards from the world origin.
 *
 * The assumption is stated rather than hidden: a placement at exactly the world origin with no
 * rotation and unit scale would never settle and would keep paying one refresh per frame. That costs
 * correctness nothing -- it is the old behaviour -- and no such placement exists in a real map.
 */
export function placementHasSettled(
  elements: ArrayLike<number>, previous: ArrayLike<number>,
): boolean {
  // Placed: a non-zero translation. `matrixWorld` is identity until the placer writes it.
  if (elements[12] === 0 && elements[13] === 0 && elements[14] === 0) {
    return false;
  }
  // And stable: this refresh produced the same matrix the last one did.
  return matrixElementsEqual(previous, elements);
}
