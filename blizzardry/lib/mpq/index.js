'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _ref = require('ref');

var _ref2 = _interopRequireDefault(_ref);

var _files = require('./files');

var _files2 = _interopRequireDefault(_files);

var _stormLib = require('./storm-lib');

var _stormLib2 = _interopRequireDefault(_stormLib);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class MPQ {

  constructor(path, flags, handle) {
    this.path = path;
    this.flags = flags;
    this.handle = handle;
    this.files = new _files2.default(this);
  }

  close() {
    var handle = this.handle;
    if (handle) {
      this.handle = null;
      return _stormLib2.default.SFileCloseArchive(handle);
    }
  }

  get opened() {
    return !!this.handle;
  }

  patch(path) {
    var prefix = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;

    if (!(this.flags & this.constructor.OPEN.READ_ONLY)) {
      throw new Error('archive must be read-only');
    }

    var flags = 0;
    return _stormLib2.default.SFileOpenPatchArchive(this.handle, path, prefix, flags);
  }

  get patched() {
    if (this.handle) {
      return _stormLib2.default.SFileIsPatchedArchive(this.handle);
    }
  }

  static get locale() {
    return _stormLib2.default.SFileGetLocale();
  }

  static set locale(locale) {
    _stormLib2.default.SFileSetLocale(locale);
  }

  static open(path) {
    var flags = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
    var callback = arguments[2];

    if (typeof flags === 'function' && callback === undefined) {
      return this.open(path, null, flags);
    }

    var priority = 0;
    var handlePtr = _ref2.default.alloc(_stormLib.HANDLEPtr);
    if (_stormLib2.default.SFileOpenArchive(path, priority, flags, handlePtr)) {
      var handle = handlePtr.deref();
      var mpq = new this(path, flags, handle);

      if (callback !== undefined) {
        callback(mpq);
        mpq.close();
        return true;
      }

      return mpq;
    }
    var errno = _stormLib2.default.GetLastError();
    throw new Error(`archive could not be found or opened (${errno})`);
  }

  static create(path, callback) {
    var flags = 0;
    var maxFileCount = 0;
    var handlePtr = _ref2.default.alloc(_stormLib.HANDLEPtr);
    if (_stormLib2.default.SFileCreateArchive(path, flags, maxFileCount, handlePtr)) {
      return this.open(path, callback);
    }
    var errno = _stormLib2.default.GetLastError();
    throw new Error(`archive could not be created (${errno})`);
  }

}

MPQ.OPEN = {
  READ_ONLY: 0x00000100,
  WRITE_SHARE: 0x00000200,
  USE_BITMAP: 0x00000400,
  NO_LISTFILE: 0x00010000,
  NO_ATTRIBUTES: 0x00020000,
  NO_HEADER_SEARCH: 0x00040000,
  FORCE_MPQ_V1: 0x00080000,
  CHECK_SECTOR_CRC: 0x00100000
};
MPQ.CREATE = {
  LISTFILE: 0x00100000,
  ATTRIBUTES: 0x00200000,
  SIGNATURE: 0x00400000,
  ARCHIVE_V1: 0x00000000,
  ARCHIVE_V2: 0x01000000,
  ARCHIVE_V3: 0x02000000,
  ARCHIVE_V4: 0x03000000
};
exports.default = MPQ;
module.exports = exports['default'];