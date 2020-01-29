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
  type: _restructure2.default.uint32le,
  name: _localizedStringRef2.default,
  additionalName: _localizedStringRef2.default,
  costModifier: _restructure2.default.floatle,
  raceID: _restructure2.default.uint32le,
  gender: _restructure2.default.uint32le,
  hairID: _restructure2.default.uint32le
});
module.exports = exports['default'];