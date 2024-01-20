'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

class CompFixed16 {

  constructor() {}

  decode(stream, parent) {
    var value = r.uint16le.decode(stream, parent);
    return (value - 32767.0) / 32767.0;
  }

}

exports.default = new CompFixed16();
module.exports = exports['default'];