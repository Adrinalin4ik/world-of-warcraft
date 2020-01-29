import { expect, fixtures, memo } from '../spec-helper';

import fs from 'fs';

import BLP from '../../lib/blp';
import Mipmap from '../../lib/blp/mipmap';

describe('BLP', function() {

  const dummy = memo().is(function() {
    return BLP.open(fixtures + 'RabbitSkin.blp');
  });

  const buffer = memo().is(function() {
    return fs.readFileSync(fixtures + 'RabbitSkin.blp');
  });

  describe('#close', function() {
    it('closes this image', function() {
      dummy().close();
    });

    it('is idempotent', function() {
      dummy().close();
      dummy().close();
    });

    context('when instantiated from disk', function() {
      it('leaves file intact', function() {
        dummy().close();
        expect(fs.existsSync(dummy().path)).to.eq(true);
      });
    });

    context('when instantiated from memory', function() {
      it('removes temporary file', function() {
        const blp = BLP.from(buffer());
        blp.close();
        expect(fs.existsSync(blp.path)).to.eq(false);
      });
    });
  });

  describe('#opened', function() {
    context('when image is open', function() {
      it('returns true', function() {
        expect(dummy().opened).to.be.true;
      });
    });

    context('when image is closed', function() {
      it('returns false', function() {
        dummy().close();
        expect(dummy().opened).to.be.false;
      });
    });
  });

  describe('#version', function() {
    it('returns version identifier', function() {
      expect(dummy().version).to.eq(2);
    });
  });

  describe('#mipmapCount', function() {
    it('returns amount of mipmaps', function() {
      expect(dummy().mipmapCount).to.eq(8);
    });
  });

  describe('#mipmaps', function() {
    it('contains mipmaps', function() {
      const mipmaps = dummy().mipmaps;
      for (let i = 0; i < 8; ++i) {
        expect(mipmaps[i]).to.be.an.instanceof(Mipmap);
      }
    });
  });

  describe('#smallest', function() {
    it('returns smallest mipmap', function() {
      const blp = dummy();
      expect(blp.smallest).to.eq(blp.mipmaps[7]);
      expect(blp.smallest.width).to.eq(1);
      expect(blp.smallest.height).to.eq(1);
    });
  });

  describe('#largest', function() {
    it('returns largest mipmap', function() {
      const blp = dummy();
      expect(blp.largest).to.eq(blp.mipmaps[0]);
      expect(blp.largest.width).to.eq(128);
      expect(blp.largest.height).to.eq(128);
    });
  });

  describe('.open', function() {
    context('when omitting a callback', function() {
      it('returns a BLP instance', function() {
        const blp = BLP.open(dummy().path);
        expect(blp).to.be.an.instanceof(BLP);
      });
    });

    context('when given a callback', function() {
      it('invokes callback with BLP instance', function() {
        const callback = this.sandbox.spy(function(blp) {
          expect(blp).to.be.an.instanceof(BLP);
        });
        const result = BLP.open(dummy().path, callback);
        expect(callback).to.have.been.called;
        expect(result).to.be.true;
      });
    });

    context('when given a malformed image', function() {
      it('throws an error', function() {
        expect(function() {
          BLP.open(__filename);
        }).to.throw('image could not be opened');
      });
    });

    context('when given a non-existent image', function() {
      it('throws an error', function() {
        expect(function() {
          BLP.open('non-existent.blp');
        }).to.throw('image could not be found');
      });
    });
  });

  describe('.from', function() {
    context('when omitting a callback', function() {
      it('returns a BLP instance', function() {
        const blp = BLP.from(buffer());
        expect(blp).to.be.an.instanceof(BLP);
        blp.close();
      });
    });

    context('when given a callback', function() {
      it('invokes callback with BLP instance', function() {
        const callback = this.sandbox.spy(function(blp) {
          expect(blp).to.be.an.instanceof(BLP);
        });
        const result = BLP.from(buffer(), callback);
        expect(callback).to.have.been.called;
        expect(result).to.be.true;
      });
    });

    context('when given a malformed image', function() {
      it('throws an error', function() {
        expect(function() {
          BLP.from(new Buffer([]));
        }).to.throw('image could not be opened');
      });
    });
  });

});
