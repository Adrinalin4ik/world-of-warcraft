'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _stringRef = require('./string-ref');

var _stringRef2 = _interopRequireDefault(_stringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class LocalizedStringRef {

  constructor() {
    this.strings = new _restructure2.default.Array(_stringRef2.default, 17);
  }

  decode(stream, parent) {
    // TODO: Add support for multiple locales
    return this.strings.decode(stream, parent)[0];
  }

}

exports.default = new LocalizedStringRef();
module.exports = exports['default'];