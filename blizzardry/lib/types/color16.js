'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class Color16 {

  constructor() {}

  decode(stream, parent) {
    var value = _restructure2.default.uint16le.decode(stream, parent);
    return value / 32767.0;
  }

}

exports.default = new Color16();
module.exports = exports['default'];