'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _ref = require('ref');

var _ref2 = _interopRequireDefault(_ref);

var _file = require('./file');

var _file2 = _interopRequireDefault(_file);

var _stormLib = require('./storm-lib');

var _stormLib2 = _interopRequireDefault(_stormLib);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class Files {

  constructor(mpq) {
    this.mpq = mpq;
  }

  get handle() {
    return this.mpq.handle;
  }

  contains(file) {
    return !!this.handle && _stormLib2.default.SFileHasFile(this.handle, file);
  }

  get(file) {
    if (this.handle) {
      var fileHandlePtr = _ref2.default.alloc(_stormLib.HANDLEPtr);
      if (_stormLib2.default.SFileOpenFileEx(this.handle, file, this.constructor.FROM_MPQ, fileHandlePtr)) {
        return new _file2.default(fileHandlePtr.deref());
      }
    }
    return null;
  }

  extract(file, target) {
    if (!_stormLib2.default.SFileExtractFile(this.handle, file, target, this.constructor.FROM_MPQ)) {
      var errno = _stormLib2.default.GetLastError();
      throw new Error(`file could not be extracted (${errno})`);
    }
    return true;
  }

  get all() {
    return this.find('*');
  }

  find(pattern) {
    var handle = null;

    var next = () => {
      var data = new _stormLib.FIND_DATA();
      if (!handle) {
        handle = _stormLib2.default.SFileFindFirstFile(this.handle, pattern, data.ref(), null);
        if (!handle.isNull()) {
          return data;
        }
      } else {
        if (_stormLib2.default.SFileFindNextFile(handle, data.ref())) {
          return data;
        }
      }
    };

    var results = [];
    var data = void 0;
    while (data = next()) {
      results.push(data);
    }

    _stormLib2.default.SFileFindClose(handle);
    return results;
  }

}

Files.FROM_MPQ = 0x00000000;
Files.FROM_LOCAL = 0xFFFFFFFF;
exports.default = Files;
module.exports = exports['default'];