'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

var _localizedStringRef = require('../localized-string-ref');

var _localizedStringRef2 = _interopRequireDefault(_localizedStringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  xp: _restructure2.default.uint32le,
  factor: _restructure2.default.floatle,
  outdoorHours: _restructure2.default.floatle,
  innHours: _restructure2.default.floatle,
  name: _localizedStringRef2.default,
  threshold: _restructure2.default.floatle
});
module.exports = exports['default'];