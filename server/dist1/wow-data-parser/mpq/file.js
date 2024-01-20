'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _stormLib = require('./storm-lib');

var _stormLib2 = _interopRequireDefault(_stormLib);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class File {

  constructor(handle) {
    this.handle = handle;
  }

  close() {
    var handle = this.handle;
    if (handle) {
      this.handle = null;
      return _stormLib2.default.SFileCloseFile(handle);
    }
  }

  get opened() {
    return !!this.handle;
  }

  get name() {
    if (this.handle) {
      var name = new Buffer(this.constructor.MAX_PATH);
      if (!_stormLib2.default.SFileGetFileName(this.handle, name)) {
        return null;
      }
      return name.readCString();
    }
  }

  get size() {
    return this.handle && _stormLib2.default.SFileGetFileSize(this.handle, null);
  }

  get data() {
    if (this.handle) {
      var data = new Buffer(this.size);
      this.position = 0;
      if (!_stormLib2.default.SFileReadFile(this.handle, data, this.size, null, null)) {
        return null;
      }
      return data;
    }
  }

  set position(offset) {
    return _stormLib2.default.SFileSetFilePointer(this.handle, offset, null, this.constructor.FILE_BEGIN);
  }

}

File.FILE_BEGIN = 0;
File.FILE_CURRENT = 1;
File.FILE_END = 2;
File.MAX_PATH = 260;
exports.default = File;
module.exports = exports['default'];