import Loader from '../../../net/loader';
import { Sequence } from './model-anim';

/**
 * The confirmed external `.anim` naming pattern.
 *
 * Verified against the live host (`https://data-direct.spelunkerdb.com/12340`):
 * `creature/wolf/wolf.m2` id 97 sub 0 -> `creature/wolf/wolf0097-00.anim`, 200, 5712 bytes.
 * `wolf-0097-00.anim`, `wolf0097-0.anim`, `wolf097-00.anim` and `Wolf0097-00.anim` all 404 --
 * ruling out a dash before the id, an unpadded sub id, an unpadded id, and case sensitivity
 * respectively. So: `<stem><animId, 4 digits><'-'><subId, 2 digits>.anim`, stem case preserved
 * here -- `Loader#normalizePath` lowercases the whole path downstream, which is also what makes
 * the host's actual case-sensitivity irrelevant to a caller of this function.
 */
export function externalAnimPath(modelPath: string, animId: number, subId: number): string {
  const stem = modelPath.replace(/\.m2$/i, '');
  const idPart = String(animId).padStart(4, '0');
  const subPart = String(subId).padStart(2, '0');
  return `${stem}${idPart}-${subPart}.anim`;
}

/** The subset of `Loader` this cache needs -- narrow so a test can inject a fake without a fetch. */
export interface AnimByteLoader {
  load(path: string): Promise<ArrayBuffer>;
}

/** A path's fetch outcome, once it leaves the "in flight" set. */
type Outcome = ArrayBuffer | 'failed';

/**
 * Called once, with the bytes, when a requested path lands.
 *
 * Takes the PATH as well as the buffer so a single long-lived, pre-bound handler can serve every
 * request a caller ever makes. `request` may be reached from a per-frame site, and a per-call arrow
 * function there would allocate a closure per frame.
 */
export type AnimLoadedHandler = (path: string, buffer: ArrayBuffer) => void;

/**
 * Fetches and caches external `.anim` files.
 *
 * Task 19's whole job: get the bytes in hand, off the frame path, at most once per path -- and no
 * more. Parsing the bytes, merging them into `ModelAnim`, and lifting the `inline` quarantine per
 * sequence are Task 20's job, not this file's; nothing here reads past the response's
 * `ArrayBuffer`.
 *
 * `request` is meant to be called from a per-frame site without a per-frame cost: the first call
 * for a given path fires the fetch, every later call -- including on a different frame, a
 * different instance of the same model, or after the fetch has failed -- is a map lookup. A 404
 * (or any other rejection `Loader#load` produces) is recorded terminally; it is never retried.
 */
export class ExternalAnimCache {

  private readonly results = new Map<string, Outcome>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly loader: AnimByteLoader = new Loader()) {}

  /** How many `.anim` fetches are currently in flight. Zero once every request has settled. */
  get pending(): number {
    return this.inFlight.size;
  }

  /** The bytes for `path`, once resolved -- `undefined` while pending, on failure, or if never requested. */
  get(path: string): ArrayBuffer | undefined {
    const outcome = this.results.get(path);
    return outcome instanceof ArrayBuffer ? outcome : undefined;
  }

  /** Whether `path` has already failed. It will not be retried. */
  failed(path: string): boolean {
    return this.results.get(path) === 'failed';
  }

  /**
   * Drop a successfully fetched payload. Failures are kept, so they stay terminal.
   *
   * Task 19 shipped this cache with no eviction path, and left the question open. It matters: a
   * creature model has up to nine sibling `.anim` files running to tens of kilobytes each, the map
   * is a module singleton, and `M2Blueprint` unloads models continuously as the player moves. Held
   * for the session, that is a real leak of the largest kind of thing this cache touches.
   *
   * The right eviction rule turns out not to be time or size but CONSUMPTION: once the keys have
   * been spliced into the model's blocks the bytes have no second reader, so `ExternalAnimBinder`
   * releases them the moment the merge settles. Dropping the entry cannot cause a refetch either --
   * a merged sequence is `inline` by then, and `request` refuses inline sequences.
   */
  release(path: string): void {
    if (this.results.get(path) !== 'failed') {
      this.results.delete(path);
    }
  }

  /**
   * Fetch `seq`'s `.anim` file, once.
   *
   * A no-op for an **inline** sequence: its keyframes are already in the `.m2`, so there is
   * nothing external to request, and requesting one anyway would 404 against a path the host
   * never serves (inline sequences are not laid out as sibling `.anim` files at all). Also a
   * no-op for a path already resolved (success or failure) or currently in flight.
   */
  request(modelPath: string, seq: Sequence, onLoaded?: AnimLoadedHandler): void {
    if (seq.inline) {
      return;
    }

    const path = externalAnimPath(modelPath, seq.id, seq.subId);
    if (this.results.has(path) || this.inFlight.has(path)) {
      return;
    }

    this.inFlight.add(path);
    this.loader.load(path)
      .then((buffer) => {
        this.inFlight.delete(path);
        this.results.set(path, buffer);
        // Fired only for a FRESH successful fetch, and deliberately not replayed for a path already
        // in the map: the caller that wants the bytes is the one that asked for them, and a handler
        // called again for an already-consumed payload would merge into a sequence that is now
        // inline. Callers that missed the edge can still `get(path)`.
        if (onLoaded) {
          onLoaded(path, buffer);
        }
      })
      .catch((err) => {
        this.inFlight.delete(path);
        this.results.set(path, 'failed');
        // eslint-disable-next-line no-console
        console.error(`Failed to fetch external animation ${path}:`, err);
      });
  }

}
