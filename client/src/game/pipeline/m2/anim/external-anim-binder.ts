import { ExternalAnimCache, externalAnimPath } from './external-anim';
import { isAliasSequence, ModelAnim, Sequence } from './model-anim';

/**
 * What a path in flight is being fetched for.
 *
 * MUTABLE, and deliberately so. A model can be unloaded and re-parsed while its `.anim` is still in
 * the air -- walking out of a zone and back in is enough -- and the payload must then land in the
 * `ModelAnim` that is now live, not the discarded one it was requested for. See `ensure`.
 */
interface Pending {
  model: ModelAnim;
  seq: Sequence;
}

/**
 * Ties the `.anim` cache to the merge: fetch the sibling files a model's quarantined sequences need,
 * and lift the quarantine as each one lands.
 *
 * ONE call site, at model load (`M2Blueprint.load`), rather than a per-frame or per-arm one. Two
 * reasons:
 *
 *   * `ensure` is a no-op for a model with no external sequences, and roughly nine placed doodads in
 *     ten animate nothing at all -- so the eager form costs the overwhelmingly common case nothing.
 *   * Fetching lazily, at the moment something tries to arm an external id, needs the *doodad* path
 *     to participate too, and a doodad never asks for an id: `armDoodad` rolls a variation and
 *     silently latches unarmable when there is none. Lazy would therefore have covered units only.
 *
 * The cost it does pay is bandwidth on creature models: `wolf.m2` pulls nine `.anim` files, about
 * 130 KB, whether or not the game ever plays those sequences. That is the deliberate trade -- see
 * this task's report.
 */
export class ExternalAnimBinder {

  private readonly pending = new Map<string, Pending>();

  constructor(private readonly cache: ExternalAnimCache = new ExternalAnimCache()) {
    // Bound ONCE. `request` takes the handlers per call, and fresh arrow functions per call would
    // allocate; these two references serve every request this binder ever makes.
    this.onLoaded = this.onLoaded.bind(this);
    this.onFailed = this.onFailed.bind(this);
  }

  /**
   * The paths this binder is still holding a `ModelAnim` for.
   *
   * Exposed because the leak it guards against is invisible from the outside: a retained entry
   * changes no behaviour at all, it just never lets a parsed model be collected. Asserting on the
   * registry directly is the only way to pin that, short of a heap probe.
   */
  retained(): string[] {
    return Array.from(this.pending.keys());
  }

  /**
   * Request every `.anim` file this model still needs, once each.
   *
   * Skips sequences that are already inline (nothing external to fetch), already merged (same
   * thing), and ALIASES -- an alias owns no keyframes, so no sibling file is written for it and the
   * request would be a guaranteed 404. See `isAliasSequence`.
   *
   * A path already IN FLIGHT is not re-requested, but its target is RE-AIMED at whichever model is
   * asking now. That is not a refinement, it is the fix for a silent loss: `pending` is keyed by
   * path and outlives the `ModelAnim` it was created for, so a model unloaded mid-flight and
   * re-parsed on the player's way back into a zone would otherwise have its payload merged into the
   * discarded object, leaving the live one quarantined for the rest of the session with no error
   * and no retry. Re-aiming is safe precisely because the two `ModelAnim`s are parses of the same
   * file: the track references the merge re-reads are identical.
   *
   * A path that has already FAILED is skipped outright rather than re-registered. The cache never
   * retries one, so a pending entry for it would never settle -- and every such entry pins a whole
   * parsed model.
   */
  ensure(modelPath: string, model: ModelAnim): void {
    const sequences = model.sequences;
    for (let i = 0, len = sequences.length; i < len; ++i) {
      const seq = sequences[i];
      if (seq.inline || isAliasSequence(seq)) {
        continue;
      }

      const path = externalAnimPath(modelPath, seq.id, seq.subId);
      if (this.cache.failed(path)) {
        continue;
      }

      const existing = this.pending.get(path);
      if (existing) {
        existing.model = model;
        existing.seq = seq;
        continue;
      }

      this.pending.set(path, { model, seq });
      this.cache.request(modelPath, seq, this.onLoaded, this.onFailed);
    }
  }

  /**
   * Merge a landed payload, then let go of it.
   *
   * The registry entry is dropped whether the merge took or not: a rejected payload is rejected
   * permanently (it is the same bytes for the same slot every time), and keeping the entry would
   * pin a `ModelAnim` the blueprint cache has since unloaded.
   */
  private onLoaded(path: string, buffer: ArrayBuffer): void {
    const entry = this.pending.get(path);
    this.pending.delete(path);
    this.cache.release(path);
    if (!entry) {
      return;
    }
    entry.model.mergeExternal(entry.seq, buffer);
  }

  /**
   * Let go of a path that will never arrive.
   *
   * Without this the registry keeps `{ model, seq }` for every 404 for the whole session, and a
   * `ModelAnim` is not a small thing to pin: it holds the entire parsed `M2AnimData` -- every
   * keyframe array of every block -- plus `boneDefs` and the cached block list. `M2Blueprint`
   * deletes its own `modelAnims` entry on unload, so after that this map is the ONLY reference
   * left, and the binder is a module singleton. A missing `.anim` is not exotic: it is what any
   * incomplete asset host produces.
   */
  private onFailed(path: string): void {
    this.pending.delete(path);
  }

}

/** The one binder the load path uses. */
export const externalAnims = new ExternalAnimBinder();
