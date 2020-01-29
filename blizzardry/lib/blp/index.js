'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _crypto = require('crypto');

var _crypto2 = _interopRequireDefault(_crypto);

var _fs = require('fs');

var _fs2 = _interopRequireDefault(_fs);

var _temp = require('temp');

var _temp2 = _interopRequireDefault(_temp);

var _blpLib = require('./blp-lib');

var _blpLib2 = _interopRequireDefault(_blpLib);

var _cLib = require('../c-lib');

var _cLib2 = _interopRequireDefault(_cLib);

var _mipmap = require('./mipmap');

var _mipmap2 = _interopRequireDefault(_mipmap);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class BLP {

  constructor(path, handle, file) {
    this.path = path;
    this.handle = handle;
    this.file = file;

    this.mipmaps = [];
    for (var i = 0; i < this.mipmapCount; ++i) {
      this.mipmaps.push(new _mipmap2.default(this, i));
    }
  }

  close() {
    var handle = this.handle;
    if (handle) {
      this.handle = null;
      _blpLib2.default.blp_release(handle);
    }

    var file = this.file;
    if (file) {
      this.file = null;
      _cLib2.default.fclose(file);

      if (this.path.match(this.constructor.TMP_PREFIX)) {
        _fs2.default.unlinkSync(this.path);
      }
    }
  }

  get opened() {
    return !!this.file;
  }

  get version() {
    return _blpLib2.default.blp_version(this.handle);
  }

  get mipmapCount() {
    return _blpLib2.default.blp_nbMipLevels(this.handle);
  }

  get smallest() {
    return this.mipmaps[this.mipmapCount - 1];
  }

  get largest() {
    return this.mipmaps[0];
  }

  static open(path, callback) {
    var file = _cLib2.default.fopen(path, 'r');
    if (!file.isNull()) {
      var handle = _blpLib2.default.blp_processFile(file);
      if (!handle.isNull()) {
        var blp = new this(path, handle, file);

        if (callback) {
          callback(blp);
          blp.close();
          return true;
        }

        return blp;
      }
      _cLib2.default.fclose(file);
      throw new Error('image could not be opened');
    }
    throw new Error('image could not be found');
  }

  static from(buffer, callback) {
    var tmp = _temp2.default.path({ prefix: this.TMP_PREFIX });
    _fs2.default.writeFileSync(tmp, buffer);
    try {
      return this.open(tmp, callback);
    } catch (e) {
      _fs2.default.unlinkSync(tmp);
      throw e;
    }
  }

}

BLP.TMP_PREFIX = `blp-${_crypto2.default.randomBytes(6).toString('hex')}-`;
exports.default = BLP;
module.exports = exports['default'];