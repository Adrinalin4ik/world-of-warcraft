'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

class Nofs {

  constructor(type, length) {
    this.type = type;
    this.length = length;
  }

  decode(stream, parent) {
    var length = r.uint32le.decode(stream);
    if (typeof this.length === 'function') {
      length = this.length.call(null, length);
    }

    if (this.type) {
      var pointer = new r.Pointer(r.uint32le, new r.Array(this.type, length), { type: 'global' });
      return pointer.decode(stream, parent);
    }

    r.uint32le.decode(stream);
    return length;
  }

}

exports.default = Nofs;
module.exports = exports['default'];