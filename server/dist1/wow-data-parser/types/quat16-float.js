'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _quat = require('./quat16');

var _quat2 = _interopRequireDefault(_quat);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class Quat16Float {

  constructor() {
    this.quat16 = _quat2.default;
  }

  decode(stream, parent) {
    var quat = this.quat16.decode(stream, parent);
    for (var prop in quat) {
      var value = quat[prop];
      quat[prop] = (value < 0 ? value + 32768 : value - 32767) / 32767;
    }
    return quat;
  }

}

exports.default = new Quat16Float();
module.exports = exports['default'];