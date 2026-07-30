import * as r from 'restructure';
import xtend from 'xtend';

const DBC = new r.Struct({
  signature: new r.String(4),

  recordCount: r.uint32le,
  fieldCount: r.uint32le,
  recordSize: r.uint32le,
  stringBlockSize: r.uint32le,
  stringBlockOffset: function() {
    return 4 * 5 + this.recordCount * this.recordSize;
  },

  records: new r.Array(new r.Buffer(function() {
    return this.recordSize;
  }), function() {
    return this.recordCount;
  }),

  stringBlock: new r.Buffer(function() {
    return this.stringBlockSize;
  })
});

/**
 * Decodes one record with `entity`, then advances the stream to the next record boundary using the
 * record width from the file header.
 *
 * Without this, records are read back to back at whatever width the entity definition happens to
 * add up to. A definition that disagrees with the file — a column added in a later build, a locale
 * block that changed size — shifts every following record by the difference, so record 0 decodes
 * correctly and the rest come out as garbage. Since records are indexed by id, a garbage record can
 * then overwrite a real one. Trusting the header keeps a mismatch contained to the fields the
 * definition actually got wrong.
 */
const stridedRecord = function(entity) {
  return {
    decode(stream, parent) {
      const start = stream.pos;
      const record = entity.decode(stream, parent);

      const recordSize = parent && parent.recordSize;
      if (recordSize) {
        stream.pos = start + recordSize;
      }

      return record;
    }
  };
};

DBC.for = function(entity) {
  const fields = xtend(this.fields, {
    entity: function() {
      return entity;
    },
    records: new r.Array(stridedRecord(entity), function() {
      return this.recordCount;
    })
  });
  return new r.Struct(fields);
};

export default DBC;
