import { ExternalAnimCache, externalAnimPath } from './external-anim';
import { isAliasSequence, ModelAnim, Sequence } from './model-anim';

/** What a path in flight is being fetched for. */
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
    // Bound ONCE. `request` takes the handler per call, and a fresh arrow function per call would
    // allocate; this one reference serves every request this binder ever makes.
    this.onLoaded = this.onLoaded.bind(this);
  }

  /**
   * Request every `.anim` file this model still needs, once each.
   *
   * Skips sequences that are already inline (nothing external to fetch), already merged (same
   * thing), already requested, and ALIASES -- an alias owns no keyframes, so no sibling file is
   * written for it and the request would be a guaranteed 404. See `isAliasSequence`.
   */
  ensure(modelPath: string, model: ModelAnim): void {
    const sequences = model.sequences;
    for (let i = 0, len = sequences.length; i < len; ++i) {
      const seq = sequences[i];
      if (seq.inline || isAliasSequence(seq)) {
        continue;
      }

      const path = externalAnimPath(modelPath, seq.id, seq.subId);
      if (this.pending.has(path)) {
        continue;
      }

      this.pending.set(path, { model, seq });
      this.cache.request(modelPath, seq, this.onLoaded);
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

}

/** The one binder the load path uses. */
export const externalAnims = new ExternalAnimBinder();
