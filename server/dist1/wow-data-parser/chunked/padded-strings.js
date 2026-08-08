'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

class PaddedStrings extends r.Array {

  constructor(length, lengthType) {
    super(new r.String(null), length, lengthType);
  }

  decode(stream, parent) {
    var res = {};

    var index = -1;
    super.decode(stream, parent).forEach(function (item) {
      index += 1;
      if (item.length) {
        res[index] = item;
      }
      index += item.length;
    });

    return res;
  }

}

exports.default = PaddedStrings;
module.exports = exports['default'];