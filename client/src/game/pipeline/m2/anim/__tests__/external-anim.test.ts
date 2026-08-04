/** @jest-environment node */
import { externalAnimPath, ExternalAnimCache, AnimByteLoader } from '../external-anim';
import { Sequence } from '../model-anim';

const seq = (over: Partial<Sequence> = {}): Sequence => ({
  index: 0, id: 97, subId: 0, lengthMs: 1000, flags: 0, probability: 32767,
  blendTimeMs: 150, moveSpeed: 0, nextAnimationId: -1, alias: 0,
  loops: true, inline: false,
  ...over,
});

/** A fake `AnimByteLoader` whose calls are recorded and whose resolution the test controls. */
class FakeLoader implements AnimByteLoader {
  calls: string[] = [];
  private resolvers = new Map<string, { resolve: (buf: ArrayBuffer) => void; reject: (err: Error) => void }>();

  load(path: string): Promise<ArrayBuffer> {
    this.calls.push(path);
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.resolvers.set(path, { resolve, reject });
    });
  }

  resolveWith(path: string, buffer: ArrayBuffer): void {
    this.resolvers.get(path)!.resolve(buffer);
  }

  rejectWith(path: string, err: Error): void {
    this.resolvers.get(path)!.reject(err);
  }
}

// Flush the microtask queue so a promise's `.then`/`.catch` chain runs before an assertion.
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('externalAnimPath', () => {
  it('matches the confirmed pattern: id 97 sub 0', () => {
    // Confirmed against the live host: 200, 5712 bytes.
    expect(externalAnimPath('creature/wolf/wolf.m2', 97, 0)).toBe('creature/wolf/wolf0097-00.anim');
  });

  it('pads a multi-digit sub id to two digits', () => {
    expect(externalAnimPath('creature/wolf/wolf.m2', 97, 12)).toBe('creature/wolf/wolf0097-12.anim');
  });

  it('pads a multi-digit anim id past four digits without truncating', () => {
    expect(externalAnimPath('creature/wolf/wolf.m2', 10234, 5)).toBe('creature/wolf/wolf10234-05.anim');
  });

  it('preserves the case of the stem', () => {
    // The host is case-sensitive (`Wolf0097-00.anim` 404s); it is `Loader#normalizePath` that
    // lowercases the whole path downstream, not this function.
    expect(externalAnimPath('Creature/Wolf/Wolf.m2', 97, 0)).toBe('Creature/Wolf/Wolf0097-00.anim');
  });
});

describe('ExternalAnimCache', () => {
  it('never requests an inline sequence', () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);

    cache.request('creature/wolf/wolf.m2', seq({ inline: true }));

    // Kills: dropping the `seq.inline` guard -- the inline sequence would be fetched anyway.
    expect(loader.calls).toEqual([]);
    expect(cache.pending).toBe(0);
  });

  it('requests each path at most once', () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);

    cache.request('creature/wolf/wolf.m2', seq({ id: 97, subId: 0 }));
    cache.request('creature/wolf/wolf.m2', seq({ id: 97, subId: 0 }));
    cache.request('creature/wolf/wolf.m2', seq({ id: 97, subId: 0 }));

    // Kills: removing the `inFlight`/`results` dedupe check -- three calls would fire three fetches.
    expect(loader.calls).toEqual(['creature/wolf/wolf0097-00.anim']);
    expect(cache.pending).toBe(1);
  });

  it('does not request the same path again after it resolves', async () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);

    cache.request('creature/wolf/wolf.m2', seq({ id: 97, subId: 0 }));
    loader.resolveWith('creature/wolf/wolf0097-00.anim', new ArrayBuffer(8));
    await flush();

    cache.request('creature/wolf/wolf.m2', seq({ id: 97, subId: 0 }));

    // Kills: dedupe keyed only on "in flight", not on the resolved-results map -- a second request
    // after success would refetch.
    expect(loader.calls).toEqual(['creature/wolf/wolf0097-00.anim']);
    expect(cache.get('creature/wolf/wolf0097-00.anim')).toBeInstanceOf(ArrayBuffer);
  });

  it('does not retry a path after it fails, and does not throw', async () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);
    const path = 'creature/wolf/wolf0097-00.anim';

    expect(() => cache.request('creature/wolf/wolf.m2', seq({ id: 97, subId: 0 }))).not.toThrow();
    loader.rejectWith(path, new Error('404 Not Found'));
    await flush();

    // Kills: not recording the failure in `results` -- a second request after a 404 would refetch
    // every frame, which is exactly the retry-storm this cache exists to prevent.
    cache.request('creature/wolf/wolf.m2', seq({ id: 97, subId: 0 }));
    await flush();

    expect(loader.calls).toEqual([path]);
    expect(cache.failed(path)).toBe(true);
    expect(cache.get(path)).toBeUndefined();
  });

  it('returns pending to zero once a failure settles', async () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);
    const path = 'creature/wolf/wolf0097-00.anim';

    cache.request('creature/wolf/wolf.m2', seq({ id: 97, subId: 0 }));
    expect(cache.pending).toBe(1);

    loader.rejectWith(path, new Error('404 Not Found'));
    await flush();

    // Kills: leaving the path in `inFlight` on the catch branch, or not deleting it there --
    // `pending` would stay stuck at 1 forever after a 404, and a caller polling it would never see
    // the fetch as settled.
    expect(cache.pending).toBe(0);
  });

  it('tracks distinct subIds of the same anim id as distinct paths', () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);

    cache.request('creature/wolf/wolf.m2', seq({ id: 97, subId: 0 }));
    cache.request('creature/wolf/wolf.m2', seq({ id: 97, subId: 1 }));

    expect(loader.calls).toEqual([
      'creature/wolf/wolf0097-00.anim',
      'creature/wolf/wolf0097-01.anim',
    ]);
    expect(cache.pending).toBe(2);
  });
});

describe('ExternalAnimCache handover to the merge', () => {
  // Kills dropping the handler: the bytes would land in the map and nothing would ever consume
  // them, so the quarantine would never lift and the failure would be entirely silent.
  it('hands the landed bytes to the caller, with the path they arrived for', async () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);
    const seen: Array<[string, number]> = [];

    cache.request('creature/wolf/wolf.m2', seq(), (path, buffer) => {
      seen.push([path, buffer.byteLength]);
    });
    loader.resolveWith('creature/wolf/wolf0097-00.anim', new ArrayBuffer(5712));
    await flush();

    expect(seen).toEqual([['creature/wolf/wolf0097-00.anim', 5712]]);
  });

  // Kills firing the handler on the catch branch, which would merge `undefined` into the model.
  it('does not hand anything over for a failed fetch', async () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let called = false;

    cache.request('creature/wolf/wolf.m2', seq(), () => { called = true; });
    loader.rejectWith('creature/wolf/wolf0097-00.anim', new Error('404'));
    await flush();

    expect(called).toBe(false);
    spy.mockRestore();
  });

  // Kills a `release` that drops failures too: the path would be refetched on every later request,
  // turning a terminal 404 into an unbounded retry loop.
  it('releases a landed payload but keeps a failure terminal', async () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    cache.request('creature/wolf/wolf.m2', seq({ id: 97 }));
    cache.request('creature/wolf/wolf.m2', seq({ id: 98 }));
    loader.resolveWith('creature/wolf/wolf0097-00.anim', new ArrayBuffer(8));
    loader.rejectWith('creature/wolf/wolf0098-00.anim', new Error('404'));
    await flush();

    cache.release('creature/wolf/wolf0097-00.anim');
    cache.release('creature/wolf/wolf0098-00.anim');

    expect(cache.get('creature/wolf/wolf0097-00.anim')).toBeUndefined();
    expect(cache.failed('creature/wolf/wolf0098-00.anim')).toBe(true);
    spy.mockRestore();
  });
});

describe('ExternalAnimCache failure notification', () => {
  // Kills a cache that only notifies on success. The caller is holding state against the path --
  // `ExternalAnimBinder` holds a whole parsed `ModelAnim` -- and "the answer never came" has to be
  // distinguishable from "the answer was no" or that state is retained for the session.
  it('notifies the caller when a fetch fails', async () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failed: string[] = [];

    cache.request('creature/wolf/wolf.m2', seq(), undefined, (path) => failed.push(path));
    loader.rejectWith('creature/wolf/wolf0097-00.anim', new Error('404'));
    await flush();

    expect(failed).toEqual(['creature/wolf/wolf0097-00.anim']);
    spy.mockRestore();
  });

  // Kills firing the failure handler on the success branch.
  it('does not report a failure for a fetch that lands', async () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);
    let failed = false;

    cache.request('creature/wolf/wolf.m2', seq(), undefined, () => { failed = true; });
    loader.resolveWith('creature/wolf/wolf0097-00.anim', new ArrayBuffer(8));
    await flush();

    expect(failed).toBe(false);
  });
});
