'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = new _restructure2.default.Pointer(_restructure2.default.uint32le, new _restructure2.default.String(null, 'utf8'), {
  type: 'global',
  relativeTo: 'parent.stringBlockOffset'
});
module.exports = exports['default'];