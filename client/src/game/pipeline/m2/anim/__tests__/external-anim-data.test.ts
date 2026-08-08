/** @jest-environment node */
import { mergeExternalAnim, MERGE_REJECTED, MergeableBlock } from '../external-anim-data';

/**
 * Build a `.anim`-shaped payload from a list of (offset, writer) placements.
 *
 * A `.anim` file has no header of any kind -- it is bare keyframe arrays at absolute offsets from
 * byte zero -- so a fixture is just "these bytes at these offsets", which is exactly what the real
 * format is. See `external-anim-data.ts` for how that layout was established.
 */
function payload(size: number, writes: Array<(view: DataView) => void>): ArrayBuffer {
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  writes.forEach((w) => w(view));
  return buffer;
}

const u32s = (offset: number, values: number[]) => (view: DataView) => {
  values.forEach((v, i) => view.setUint32(offset + i * 4, v, true));
};

const f32s = (offset: number, values: number[]) => (view: DataView) => {
  values.forEach((v, i) => view.setFloat32(offset + i * 4, v, true));
};

const u16s = (offset: number, values: number[]) => (view: DataView) => {
  values.forEach((v, i) => view.setUint16(offset + i * 2, v, true));
};

/**
 * A block holding the parsed NOISE an external slot decodes to, plus the refs the merge re-reads.
 *
 * The noise values are deliberately not the channel identity. A translation track starting at
 * `[0, 0, 0]` is what an unmerged bone poses to anyway, so a fixture built on one asserts nothing:
 * it passes whether or not the merge ran.
 */
function noisyBlock(
  valueTypeName: string,
  tsRef: { count: number; offset: number },
  valRef: { count: number; offset: number },
  slot = 0,
): MergeableBlock {
  const tracks: any[] = [];
  for (let i = 0; i <= slot; ++i) {
    tracks.push({
      animationIndex: i,
      timestamps: [3197923783],
      values: [[9, 9, 9]],
      timestampsRef: i === slot ? tsRef : { count: 0, offset: 0 },
      valuesRef: i === slot ? valRef : { count: 0, offset: 0 },
    });
  }
  return { interpolationType: 1, globalSequenceID: -1, valueTypeName, tracks };
}

describe('mergeExternalAnim', () => {
  it('replaces the parsed noise with the payload keys', () => {
    // 2 timestamps at 0, 2 float32array3 values at 8.
    const buffer = payload(32, [u32s(0, [0, 1000]), f32s(8, [7, 0, 0, 8, 1, 2])]);
    const block = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 2, offset: 8 });

    expect(mergeExternalAnim([block], 0, 1000, buffer)).toBe(1);
    expect(block.tracks[0].timestamps).toEqual([0, 1000]);
    expect(block.tracks[0].values).toEqual([[7, 0, 0], [8, 1, 2]]);
  });

  // Kills a merge that re-decodes compfixed16 by some other rule -- 65534 is +1.0 under the
  // parser's `(u16 - 32767) / 32767` and +2.0 under a naive `u16 / 32767`.
  it('decodes quaternions by the parser own compfixed16 rule', () => {
    const buffer = payload(16, [u32s(0, [0]), u16s(4, [32767, 32767, 32767, 65534])]);
    const block = noisyBlock('compfixed16array4', { count: 1, offset: 0 }, { count: 1, offset: 4 });

    expect(mergeExternalAnim([block], 0, 500, buffer)).toBe(1);
    const q = block.tracks[0].values[0] as number[];
    expect(q[0]).toBeCloseTo(0, 5);
    expect(q[3]).toBeCloseTo(1, 4);
  });

  // Kills dropping the timestamp-window test -- THE test that exposed the noise in the first place.
  it('rejects a payload whose timestamps run past the sequence length', () => {
    const buffer = payload(32, [u32s(0, [0, 1001]), f32s(8, [7, 0, 0, 8, 1, 2])]);
    const block = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 2, offset: 8 });

    expect(mergeExternalAnim([block], 0, 1000, buffer)).toBe(MERGE_REJECTED);
    expect(block.tracks[0].timestamps).toEqual([3197923783]);
  });

  // Kills dropping the monotonicity test. Both stamps are inside the window, so the window test
  // alone cannot catch this one.
  it('rejects a payload whose timestamps go backwards', () => {
    const buffer = payload(32, [u32s(0, [800, 400]), f32s(8, [7, 0, 0, 8, 1, 2])]);
    const block = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 2, offset: 8 });

    expect(mergeExternalAnim([block], 0, 1000, buffer)).toBe(MERGE_REJECTED);
  });

  // Kills dropping the bounds test: without it the decode runs off the end of the payload and the
  // track fills with undefined, which is NaN in a bone matrix.
  it('rejects a track whose value range runs past the end of the payload', () => {
    const buffer = payload(20, [u32s(0, [0, 1000]), f32s(8, [7, 0, 0])]);
    const block = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 2, offset: 8 });

    expect(mergeExternalAnim([block], 0, 1000, buffer)).toBe(MERGE_REJECTED);
  });

  // Kills dropping the count agreement test -- `bracket` walks timestamps and indexes values.
  it('rejects a track whose timestamp and value counts disagree', () => {
    const buffer = payload(32, [u32s(0, [0, 1000]), f32s(8, [7, 0, 0])]);
    const block = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 1, offset: 8 });

    expect(mergeExternalAnim([block], 0, 1000, buffer)).toBe(MERGE_REJECTED);
  });

  // Kills an apply-as-you-go merge. The first block is perfectly valid and would be written by one.
  it('writes nothing at all when a later track is rejected', () => {
    const buffer = payload(32, [u32s(0, [0, 1000]), f32s(8, [7, 0, 0, 8, 1, 2])]);
    const good = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 2, offset: 8 });
    const bad = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 2, offset: 900 });

    expect(mergeExternalAnim([good, bad], 0, 1000, buffer)).toBe(MERGE_REJECTED);
    expect(good.tracks[0].timestamps).toEqual([3197923783]);
    expect(good.tracks[0].values).toEqual([[9, 9, 9]]);
  });

  // Kills silently skipping a block the merge cannot decode: that block would keep its `.m2` noise
  // while every neighbour got real keys -- half a rig from the wrong data.
  it('rejects a block whose value type it cannot decode', () => {
    const buffer = payload(32, [u32s(0, [0, 1000]), f32s(8, [7, 0, 0, 8, 1, 2])]);
    const block = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 2, offset: 8 });
    block.valueTypeName = 'someUnknownType';

    expect(mergeExternalAnim([block], 0, 1000, buffer)).toBe(MERGE_REJECTED);
  });

  // Kills treating "this sequence does not drive this channel" as a fault. Most bones do not.
  it('leaves an empty track alone and still merges its neighbours', () => {
    const buffer = payload(32, [u32s(0, [0, 1000]), f32s(8, [7, 0, 0, 8, 1, 2])]);
    const empty = noisyBlock('float32array3', { count: 0, offset: 0 }, { count: 0, offset: 0 });
    const keyed = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 2, offset: 8 });

    expect(mergeExternalAnim([empty, keyed], 0, 1000, buffer)).toBe(1);
    expect(empty.tracks[0].timestamps).toEqual([3197923783]);
    expect(keyed.tracks[0].timestamps).toEqual([0, 1000]);
  });

  // Kills returning 0 (a falsy "success") for a payload that matched nothing. An external sequence
  // has keys by definition -- that is why they were moved out of the `.m2` -- so a payload that
  // yields none is the wrong file, not an empty animation.
  it('rejects a payload that yields no tracks at all', () => {
    const empty = noisyBlock('float32array3', { count: 0, offset: 0 }, { count: 0, offset: 0 });
    expect(mergeExternalAnim([empty], 0, 1000, payload(32, []))).toBe(MERGE_REJECTED);
  });

  // Kills reading the refs from a fixed slot instead of the one asked for.
  it('reads the refs of the requested slot, not slot 0', () => {
    const buffer = payload(32, [u32s(0, [0, 1000]), f32s(8, [7, 0, 0, 8, 1, 2])]);
    const block = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 2, offset: 8 }, 3);

    expect(mergeExternalAnim([block], 3, 1000, buffer)).toBe(1);
    expect(block.tracks[3].timestamps).toEqual([0, 1000]);
    expect(block.tracks[0].timestamps).toEqual([3197923783]);
  });

  // Kills accepting `UNARMED_SLOT`, which would index past the start of every tracks array.
  it('rejects a negative slot', () => {
    const block = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 2, offset: 8 });
    expect(mergeExternalAnim([block], -1, 1000, payload(32, []))).toBe(MERGE_REJECTED);
  });

  // Kills assuming every block carries refs. Particle and ribbon blocks are not tagged, and a block
  // from an older parse has no refs at all -- neither is a fault, and neither is mergeable.
  it('ignores a block that carries no refs', () => {
    const buffer = payload(32, [u32s(0, [0, 1000]), f32s(8, [7, 0, 0, 8, 1, 2])]);
    const bare: MergeableBlock = {
      interpolationType: 1, globalSequenceID: -1,
      tracks: [{ animationIndex: 0, timestamps: [1], values: [[9, 9, 9]] }],
    };
    const keyed = noisyBlock('float32array3', { count: 2, offset: 0 }, { count: 2, offset: 8 });

    expect(mergeExternalAnim([bare, keyed], 0, 1000, buffer)).toBe(1);
    expect(bare.tracks[0].timestamps).toEqual([1]);
  });
});
