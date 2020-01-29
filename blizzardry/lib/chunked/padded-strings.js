'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class PaddedStrings extends _restructure2.default.Array {

  constructor(length, lengthType) {
    super(new _restructure2.default.String(null), length, lengthType);
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