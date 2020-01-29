'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class Nofs {

  constructor(type, length) {
    this.type = type;
    this.length = length;
  }

  decode(stream, parent) {
    var length = _restructure2.default.uint32le.decode(stream);
    if (typeof this.length === 'function') {
      length = this.length.call(null, length);
    }

    if (this.type) {
      var pointer = new _restructure2.default.Pointer(_restructure2.default.uint32le, new _restructure2.default.Array(this.type, length), 'global');
      return pointer.decode(stream, parent);
    }

    _restructure2.default.uint32le.decode(stream);
    return length;
  }

}

exports.default = Nofs;
module.exports = exports['default'];