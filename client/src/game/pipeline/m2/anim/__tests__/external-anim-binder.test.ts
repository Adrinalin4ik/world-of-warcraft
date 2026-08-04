/** @jest-environment node */
import { AnimByteLoader, ExternalAnimCache } from '../external-anim';
import { ExternalAnimBinder } from '../external-anim-binder';
import { ModelAnim } from '../model-anim';

/** `0x20` = inline in the `.m2`. `0` = external, `0x40` = alias. */
const INLINE = 0x20;

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: INLINE, probability: 32767,
  blendTime: 0, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

/** One bone whose slot-0 translation holds noise plus the refs a merge re-reads. */
const externalBone = () => ({
  parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
  translation: {
    interpolationType: 1, globalSequenceID: -1, valueTypeName: 'float32array3',
    tracks: [{
      animationIndex: 0, timestamps: [3197923783], values: [[9, 9, 9]],
      timestampsRef: { count: 2, offset: 0 }, valuesRef: { count: 2, offset: 8 },
    }],
  },
  rotation: { interpolationType: 1, globalSequenceID: -1, tracks: [] },
  scaling: { interpolationType: 1, globalSequenceID: -1, tracks: [] },
});

/**
 * 2 timestamps at 0, 2 float32array3 values at 8.
 *
 * The first value is `[7, 0, 0]`, deliberately not the origin: a bone that never got merged poses
 * to bind pose and an unarmed instance samples at cursor 0, so an identity first key would let the
 * assertions pass with the merge removed.
 */
const payload = () => {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  view.setUint32(0, 0, true);
  view.setUint32(4, 1000, true);
  [7, 0, 0, 8, 1, 2].forEach((v, i) => view.setFloat32(8 + i * 4, v, true));
  return buffer;
};

class FakeLoader implements AnimByteLoader {
  calls: string[] = [];
  private resolvers = new Map<string, (buf: ArrayBuffer) => void>();

  load(path: string): Promise<ArrayBuffer> {
    this.calls.push(path);
    return new Promise<ArrayBuffer>((resolve) => { this.resolvers.set(path, resolve); });
  }

  resolveWith(path: string, buffer: ArrayBuffer): void {
    this.resolvers.get(path)!(buffer);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Slot 0 external (id 97), slot 1 inline, slot 2 an external ALIAS. */
const model = () => new ModelAnim({
  animations: [
    animation({ id: 97, flags: 0 }),
    animation({ id: 0, flags: INLINE }),
    animation({ id: 62, flags: 0x40, alias: 1 }),
  ],
  sequences: [],
  bones: [externalBone()],
} as any);

describe('ExternalAnimBinder#ensure', () => {
  // Kills requesting every sequence: an inline one has nothing external to fetch and the host does
  // not serve a sibling file for it.
  // Kills dropping the ALIAS skip: an alias owns no keyframes, so no `.anim` is written for it --
  // measured, `wolf0062-00.anim` and `kobold0136-00.anim` both 404.
  it('requests the external non-alias sequences, and nothing else', () => {
    const loader = new FakeLoader();
    new ExternalAnimBinder(new ExternalAnimCache(loader)).ensure('creature/wolf/wolf.m2', model());

    expect(loader.calls).toEqual(['creature/wolf/wolf0097-00.anim']);
  });

  it('requests each path at most once across repeated calls', () => {
    const loader = new FakeLoader();
    const binder = new ExternalAnimBinder(new ExternalAnimCache(loader));
    const m = model();

    binder.ensure('creature/wolf/wolf.m2', m);
    binder.ensure('creature/wolf/wolf.m2', m);

    expect(loader.calls).toHaveLength(1);
  });

  // Kills a binder that fetches but never merges -- the whole point of the class.
  it('merges the payload and lifts the quarantine when it lands', async () => {
    const loader = new FakeLoader();
    const binder = new ExternalAnimBinder(new ExternalAnimCache(loader));
    const m = model();

    binder.ensure('creature/wolf/wolf.m2', m);
    expect(m.sequences[0].inline).toBe(false);

    loader.resolveWith('creature/wolf/wolf0097-00.anim', payload());
    await flush();

    expect(m.sequences[0].inline).toBe(true);
    expect(m.boneDefs[0].translation.tracks[0].values).toEqual([[7, 0, 0], [8, 1, 2]]);
    expect(m.animated).toBe(true);
  });

  // Kills leaving the payload in the cache. The map has no other eviction path, `M2Blueprint`
  // unloads models continuously, and these are the largest objects the cache holds.
  it('releases the bytes once they have been consumed', async () => {
    const loader = new FakeLoader();
    const cache = new ExternalAnimCache(loader);
    const binder = new ExternalAnimBinder(cache);

    binder.ensure('creature/wolf/wolf.m2', model());
    loader.resolveWith('creature/wolf/wolf0097-00.anim', payload());
    await flush();

    expect(cache.get('creature/wolf/wolf0097-00.anim')).toBeUndefined();
  });

  // Kills re-requesting a merged path -- the release above would otherwise reopen the fetch.
  it('asks for nothing more once every sequence has merged', async () => {
    const loader = new FakeLoader();
    const binder = new ExternalAnimBinder(new ExternalAnimCache(loader));
    const m = model();

    binder.ensure('creature/wolf/wolf.m2', m);
    loader.resolveWith('creature/wolf/wolf0097-00.anim', payload());
    await flush();

    binder.ensure('creature/wolf/wolf.m2', m);
    expect(loader.calls).toHaveLength(1);
  });

  // Kills flipping the quarantine off the fetch rather than off the merge. A rejected payload must
  // leave the sequence exactly as unplayable as it was.
  it('leaves the quarantine in place when the payload is rejected', async () => {
    const loader = new FakeLoader();
    const binder = new ExternalAnimBinder(new ExternalAnimCache(loader));
    const m = model();

    binder.ensure('creature/wolf/wolf.m2', m);
    loader.resolveWith('creature/wolf/wolf0097-00.anim', new ArrayBuffer(4));
    await flush();

    expect(m.sequences[0].inline).toBe(false);
    expect(m.mergeVersion).toBe(0);
  });

  it('does no work at all for a model with no external sequence', () => {
    const loader = new FakeLoader();
    const inlineOnly = new ModelAnim({
      animations: [animation({ id: 0, flags: INLINE })], sequences: [], bones: [],
    } as any);

    new ExternalAnimBinder(new ExternalAnimCache(loader)).ensure('world/tree.m2', inlineOnly);
    expect(loader.calls).toEqual([]);
  });
});
