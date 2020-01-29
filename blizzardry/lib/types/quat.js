'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = new _restructure2.default.Struct({
  x: _restructure2.default.floatle,
  y: _restructure2.default.floatle,
  z: _restructure2.default.floatle,
  w: _restructure2.default.floatle
});
module.exports = exports['default'];