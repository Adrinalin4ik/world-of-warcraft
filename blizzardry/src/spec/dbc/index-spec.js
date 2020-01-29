import { expect, fixtures } from '../spec-helper';

import fs from 'fs';
import r from 'restructure';

import DBC from '../../lib/dbc';
import Entity from '../../lib/dbc/entity';
import LocalizedStringRef from '../../lib/dbc/localized-string-ref';
import StringRef from '../../lib/dbc/string-ref';

describe('DBC', function() {

  const Sample = Entity({
    id: r.uint32le,
    name: StringRef,
    localizedName: LocalizedStringRef,
    points: r.int32le,
    height: r.floatle
  });

  const stream = function() {
    const data = fs.readFileSync(fixtures + 'Sample.dbc');
    return new r.DecodeStream(data);
  };

  const dummy = (function() {
    return DBC.decode(stream());
  }());

  const withEntity = (function() {
    return Sample.dbc.decode(stream());
  }());

  describe('#signature', function() {
    it('returns WDBC', function() {
      expect(dummy.signature).to.eq('WDBC');
    });
  });

  describe('#recordCount', function() {
    it('returns amount of records', function() {
      expect(dummy.recordCount).to.eq(3);
    });
  });

  describe('#fieldCount', function() {
    it('returns amount of fields', function() {
      expect(dummy.fieldCount).to.eq(21);
    });
  });

  describe('#recordSize', function() {
    it('returns size of a single record', function() {
      expect(dummy.recordSize).to.eq(84);
    });
  });

  describe('#stringBlockSize', function() {
    it('returns size of string block', function() {
      expect(dummy.stringBlockSize).to.eq(10);
    });
  });

  describe('#stringBlockOffset', function() {
    it('returns offset of string block', function() {
      expect(dummy.stringBlockOffset).to.eq(272);
    });
  });

  describe('#records', function() {
    context('when not using an entity', function() {
      it('returns raw records', function() {
        const records = dummy.records;
        const [record] = records;
        expect(records.length).to.eq(3);
        expect(record).to.be.an.instanceof(Buffer);
        expect(record).to.have.length(dummy.recordSize);
      });
    });

    context('when using an entity', function() {
      it('returns records', function() {
        const records = withEntity.records;
        const [first, , last] = records;
        expect(records.length).to.eq(3);
        expect(first).to.deep.eq({
          id: 1,
          name: 'John',
          localizedName: 'Jon',
          points: -1,
          height: 1.7999999523162842
        });
        expect(last).to.deep.eq({
          id: 3,
          name: 'Brad',
          localizedName: 'Bradley',
          points: -10,
          height: 1.5499999523162842
        });
      });
    });
  });

  describe('#entity', function() {
    context('when not using an entity', function() {
      it('is not present', function() {
        expect(dummy.entity).to.be.undefined;
      });
    });

    context('when using an entity', function() {
      it('returns entity', function() {
        expect(withEntity.entity).to.eq(Sample);
      });
    });
  });

});
