import * as r from 'restructure';

import { color16, compfixed16array4, float32array3 } from '../../../../wow-data-parser/types';
import { AnimBlock, SeqTrack } from './tracks';

/**
 * The `.anim` layout, established empirically -- there is no header to read it from.
 *
 * A 3.3.5a `.anim` file is NOT a container. It carries no signature, no version, no table of
 * contents and no bone count: it is the raw keyframe payload the `.m2`'s animation blocks already
 * point into for exactly one sequence, lifted out into a sibling file. Every `(count, offset)` an
 * external sequence's block records in the `.m2` is therefore an offset into the `.anim` buffer,
 * from byte zero, and nothing else about the two files' relationship needs to be known.
 *
 * The evidence (see this task's report for the full probe output):
 *
 *   * `wolf.m2` slot 19 (id 97, length 2000 ms) has 34 bone tracks. Read against `wolf0097-00.anim`
 *     every one is fully inside the file, every timestamp is monotonically non-decreasing, and
 *     every timestamp lands in `[0, 2000]` -- e.g. bone 3's rotation reads `0, 167, 600, 933, 1167,
 *     1733, 2000`. Read against the `.m2`, as the parser does today, the same track reads
 *     `1068675878, 1078723390, 1077182499, 3197923783, ...`: the exact noise the Task 17 quarantine
 *     was built to contain.
 *   * The 231 quaternions in that slot all decompress to unit norm (worst 0.9999). Noise does not
 *     land on the unit 3-sphere 231 times.
 *   * Repeated for `wolf0069-00.anim` (35 tracks), `wolf0128-00.anim` (37), `wolf0123-00.anim` (37),
 *     `kobold0062-00.anim` (43) and `kobold0062-01.anim` (46). Zero violations in any of them.
 *   * NEGATIVE CONTROLS. Feeding `wolf0128-00.anim` to slot 19, and `kobold0062-01.anim` to the
 *     sub-id-0 slot that wants `-00`, both break the timestamp test immediately. So the test below
 *     discriminates; it is not something any pile of bytes passes.
 *   * Only BONE blocks were observed to carry keys in an external slot -- UV, transparency and
 *     vertex-colour blocks had none across every model and slot probed. The merge still walks them,
 *     because "not observed" is not "cannot happen" and walking them costs one integer compare each.
 *
 * A consequence worth naming: offset ZERO is a legitimate `.anim` offset (it is where `wolf.m2`
 * bone 0's translation timestamps live for slot 19), whereas in a `.m2` it never means anything.
 * That is why `TrackRef` in the parser records the raw offset rather than leaning on the decoded
 * array, and why nothing here treats 0 as absent.
 */

/** Value decoders the merge can drive, by the name the parser tags each block with. */
const VALUE_TYPES: { [name: string]: { type: any; size: number } } = {
  float32array3: { type: float32array3, size: 12 },
  compfixed16array4: { type: compfixed16array4, size: 8 },
  color16: { type: color16, size: 2 },
};

/** A raw `(count, offset)` pair as `animation-block.js` records it. */
export interface TrackRef {
  count: number;
  offset: number;
}

/** A parsed track, with the file references the merge re-reads. */
export interface RefTrack extends SeqTrack {
  timestampsRef?: TrackRef | null;
  valuesRef?: TrackRef | null;
}

/** An animation block carrying the value-type tag the merge needs. */
export interface MergeableBlock extends AnimBlock {
  valueTypeName?: string | null;
  tracks: RefTrack[];
}

/** One track's real keys, staged but not yet applied. */
interface Staged {
  track: RefTrack;
  timestamps: number[];
  values: unknown[];
}

/** `mergeExternalAnim` refused the payload; nothing was written. */
export const MERGE_REJECTED = -1;

/**
 * Decode `count` values of `type` at `offset`.
 *
 * Through restructure and the parser's OWN value types (`wow-data-parser/types`) rather than a
 * hand-written `DataView` reader. The `.anim` payload is the same bytes the `.m2` block would have
 * held, so it must decode by the same rules -- `compfixed16`'s `(u16 - 32767) / 32767` and
 * `color16`'s `u16 / 32767` are easy to reimplement and easy to reimplement slightly differently,
 * and a merged track that is subtly off decodes as a subtly wrong pose with nothing to point at.
 */
function decodeArray(stream: any, offset: number, count: number, type: any): any[] {
  stream.pos = offset;
  return new r.Array(type, count).decode(stream);
}

/**
 * Splice one external sequence's real keys out of a `.anim` payload and into `blocks`.
 *
 * ALL OR NOTHING. Every track is validated against the payload first and only written once the
 * whole set has passed, because the failure this guards is a `.anim` from a different model or a
 * different sequence -- and a half-applied merge of one of those poses part of the skeleton from
 * the wrong rig while the rest keeps its bind pose, which looks like a rigging bug rather than a
 * loading one. Rejecting outright leaves the sequence quarantined, which is a state the whole
 * system already handles.
 *
 * There is deliberately no bone-COUNT check, because there is nothing to compare against: the
 * `.anim` has no header, and the track set being merged is read out of the `.m2`'s own blocks, so
 * its length is the model's own bone count by construction. What a foreign `.anim` actually
 * produces is out-of-range offsets and out-of-window timestamps, and those are what is tested --
 * verified against real mismatched files, not assumed.
 *
 * @returns the number of tracks merged, or `MERGE_REJECTED`.
 */
export function mergeExternalAnim(
  blocks: MergeableBlock[],
  slot: number,
  lengthMs: number,
  buffer: ArrayBuffer,
): number {
  if (slot < 0 || !buffer) {
    return MERGE_REJECTED;
  }

  const staged: Staged[] = [];
  const byteLength = buffer.byteLength;
  // One stream for the whole merge -- a `.anim` runs to tens of kilobytes and a per-track copy of
  // it would be a hundred of them. This is a load-path allocation, not a per-frame one, but the
  // copy is the expensive part of the whole operation.
  const stream = new r.DecodeStream(Buffer.from(new Uint8Array(buffer)));

  for (let i = 0, len = blocks.length; i < len; ++i) {
    const block = blocks[i];
    const track = block.tracks ? block.tracks[slot] : undefined;
    if (!track) {
      continue;
    }

    const tRef = track.timestampsRef;
    const vRef = track.valuesRef;
    if (!tRef || !vRef || tRef.count === 0) {
      // No refs at all means a block that predates the parser capturing them -- nothing to merge,
      // and nothing wrong. A zero count means this sequence simply does not drive this channel.
      continue;
    }

    // A channel whose keys the merge cannot re-decode must not be left holding `.m2` noise while
    // its neighbours get real data. That is the half-a-rig failure, one channel at a time.
    const value = block.valueTypeName ? VALUE_TYPES[block.valueTypeName] : undefined;
    if (!value) {
      return MERGE_REJECTED;
    }

    if (tRef.count !== vRef.count) {
      return MERGE_REJECTED;
    }
    if (tRef.offset < 0 || tRef.offset + tRef.count * 4 > byteLength) {
      return MERGE_REJECTED;
    }
    if (vRef.offset < 0 || vRef.offset + vRef.count * value.size > byteLength) {
      return MERGE_REJECTED;
    }

    const timestamps = decodeArray(stream, tRef.offset, tRef.count, r.uint32le) as number[];

    // The sanity test that exposed the noise in the first place: a sequence's own keys cannot run
    // past its own length, and cannot go backwards.
    let previous = -1;
    for (let k = 0; k < timestamps.length; ++k) {
      const t = timestamps[k];
      if (t < previous || t > lengthMs) {
        return MERGE_REJECTED;
      }
      previous = t;
    }

    staged.push({
      track,
      timestamps,
      values: decodeArray(stream, vRef.offset, vRef.count, value.type),
    });
  }

  // An `.anim` that yields nothing is the wrong file for this slot, not an empty animation: the
  // sequence would not have been external if it had no keys to move out of the `.m2`.
  if (staged.length === 0) {
    return MERGE_REJECTED;
  }

  for (let i = 0, len = staged.length; i < len; ++i) {
    // IN PLACE, into the same `tracks[slot]` object every sampler already indexes. Nothing is
    // dropped, renumbered or appended -- `Sequence.index` is the file slot, and it stays the file
    // slot.
    staged[i].track.timestamps = staged[i].timestamps;
    staged[i].track.values = staged[i].values;
  }

  return staged.length;
}
