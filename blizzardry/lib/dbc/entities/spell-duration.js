'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  baseDuration: _restructure2.default.uint32le,
  perLevel: _restructure2.default.uint32le,
  maxDuration: _restructure2.default.uint32le
});
module.exports = exports['default'];