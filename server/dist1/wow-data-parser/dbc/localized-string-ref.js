'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _stringRef = require('./string-ref');

var _stringRef2 = _interopRequireDefault(_stringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

class LocalizedStringRef {

  constructor() {
    this.strings = new r.Array(_stringRef2.default, 17);
  }

  decode(stream, parent) {
    // TODO: Add support for multiple locales
    return this.strings.decode(stream, parent)[0];
  }

}

exports.default = new LocalizedStringRef();
module.exports = exports['default'];