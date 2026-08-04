import r from 'restructure';

import Nofs from './nofs';

/**
 * One sequence slot's key array, decoded AND still carrying the raw `(count, offset)` it came from.
 *
 * The offset is the whole point. For a sequence whose keyframes live in a sibling `.anim` file the
 * offset is relative to THAT file, not to the `.m2` -- so the array decoded here is noise (see
 * `game/pipeline/m2/anim/model-anim.ts#hasInlineData`), and the only way to recover the real keys is
 * to re-read the same `(count, offset)` against the `.anim` buffer once it arrives. Restructure's
 * `Pointer` consumes the offset word and throws it away, which is exactly the information the merge
 * needs, so it is captured here before the pointer re-reads it.
 *
 * Deliberately a plain `{ count, offset, items }` object rather than an array with properties hung
 * off it: the parsed M2 crosses a `postMessage` boundary out of the loader worker, and structured
 * clone is only reliable about own enumerable properties of plain objects.
 */
class TrackRef {

  constructor(type) {
    this.type = type;
  }

  decode(stream, parent) {
    const count = r.uint32le.decode(stream);

    // Peek the offset word, then rewind so `Pointer` reads it again itself. Reading it twice keeps
    // the pointer's own semantics (global-relative, and NOT null-checked -- see `nofs.js`) exactly
    // as they were, instead of reimplementing them here and drifting.
    const offsetPos = stream.pos;
    const offset = r.uint32le.decode(stream);
    stream.pos = offsetPos;

    const pointer = new r.Pointer(r.uint32le, new r.Array(this.type, count), 'global');
    const items = pointer.decode(stream, parent);

    return { count, offset, items: items || [] };
  }

}

/**
 * @param type restructure type of one keyframe VALUE.
 * @param valueTypeName name of that type in `wow-data-parser/types`, or null. Only the blocks whose
 *   keys the external-`.anim` merge can re-decode need one; see
 *   `game/pipeline/m2/anim/external-anim-data.ts#VALUE_TYPES`. A block without a name is simply not
 *   a merge candidate -- it is never merged from noise, it is left alone.
 */
export default function(type, valueTypeName = null) {
  return new r.Struct({
    interpolationType: r.uint16le,
    globalSequenceID: r.int16le,
    timestamps: new Nofs(new TrackRef(r.uint32le)),
    // timestamps: new Nofs(r.uint32le),
    values: new Nofs(new TrackRef(type)),

    valueTypeName: function() {
      return valueTypeName;
    },

    trackCount: function() {
      return this.values.length;
    },

    tracks: function() {
      const tracks = [];

      for (let trackIndex = 0; trackIndex < this.trackCount; trackIndex++) {
        const track = {};

        // Corresponds to offset in animations array of MD2.
        track.animationIndex = trackIndex;

        const timestamps = this.timestamps[trackIndex];
        const values = this.values[trackIndex];

        track.timestamps = timestamps ? timestamps.items : [];
        track.values = values ? values.items : [];

        // The raw file references, kept per track so the external-`.anim` merge can re-read this
        // slot against the right buffer. Null only for a slot the block does not declare at all.
        track.timestampsRef = timestamps ? { count: timestamps.count, offset: timestamps.offset } : null;
        track.valuesRef = values ? { count: values.count, offset: values.offset } : null;

        tracks.push(track);
      }

      return tracks;
    },

    maxTrackLength: function() {
      let max = 0;

      this.tracks.forEach((track) => {
        if (track.timestamps.length > max) {
          max = track.timestamps.length;
        }
      });

      return max;
    },

    keyframeCount: function() {
      let keyframeCount = 0;

      for (let i = 0, len = this.tracks.length; i < len; ++i) {
        keyframeCount += this.tracks[i].timestamps.length;
      }

      return keyframeCount;
    },

    firstKeyframe: function() {
      if (this.tracks.length === 0) {
        return null;
      } else {
        for (let i = 0, len = this.tracks.length; i < len; ++i) {
          const track = this.tracks[i];

          if (track.timestamps.length > 0) {
            return {
              timestamp: track.timestamps[0],
              value: track.values[0]
            };
          }
        }

        return null;
      }
    },

    empty: function() {
      return this.maxTrackLength === 0;
    },

    animated: function() {
      return !this.empty;
    }
  });
}
