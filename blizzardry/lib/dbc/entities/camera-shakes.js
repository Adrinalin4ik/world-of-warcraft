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
  type: _restructure2.default.uint32le,
  direction: _restructure2.default.uint32le,
  amplitude: _restructure2.default.floatle,
  frequency: _restructure2.default.floatle,
  duration: _restructure2.default.floatle,
  phase: _restructure2.default.floatle,
  coefficient: _restructure2.default.floatle
});
module.exports = exports['default'];