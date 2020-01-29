'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _compFixed = require('./comp-fixed16');

var _compFixed2 = _interopRequireDefault(_compFixed);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = new _restructure2.default.Array(_compFixed2.default, 4);
module.exports = exports['default'];