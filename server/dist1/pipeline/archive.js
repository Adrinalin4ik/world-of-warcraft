'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _globby = require('globby');

var _globby2 = _interopRequireDefault(_globby);

var _mpq = require('../wow-data-parser/mpq');

var _mpq2 = _interopRequireDefault(_mpq);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class Archive {

  static build(root) {
    var patterns = this.CHAIN.map(function (path) {
      return `${root}/${path}`;
    });

    var archives = _globby2.default.sync(patterns);

    var base = _mpq2.default.open(archives.shift(), _mpq2.default.OPEN.READ_ONLY);
    archives.forEach(function (archive) {
      base.patch(archive, '');
    });
    return base;
  }

}

Archive.CHAIN = ['common.MPQ', 'common-2.MPQ', 'expansion.MPQ', 'lichking.MPQ', '*/locale-*.MPQ', '*/speech-*.MPQ', '*/expansion-locale-*.MPQ', '*/lichking-locale-*.MPQ', '*/expansion-speech-*.MPQ', '*/lichking-speech-*.MPQ', '*/patch-*.MPQ', 'patch.MPQ', 'patch-*.MPQ'];
exports.default = Archive;
module.exports = exports['default'];