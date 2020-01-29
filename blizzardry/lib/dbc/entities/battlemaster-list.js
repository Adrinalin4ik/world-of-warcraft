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
  instanceIDs: new _restructure2.default.Array(_restructure2.default.int32le, 8),
  type: _restructure2.default.uint32le,
  minLevel: _restructure2.default.uint32le,
  maxLevel: _restructure2.default.uint32le,
  teamSize: _restructure2.default.uint32le,
  unknowns: new _restructure2.default.Reserved(_restructure2.default.uint32le, 3),
  name: _localizedStringRef2.default,
  unknowns2: new _restructure2.default.Reserved(_restructure2.default.uint32le, 2)
});
module.exports = exports['default'];