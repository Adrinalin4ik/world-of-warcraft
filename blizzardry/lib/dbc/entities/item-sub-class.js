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
  classID: _restructure2.default.uint32le,
  subClassID: _restructure2.default.uint32le,
  prerequisiteProficiency: _restructure2.default.int32le,
  postrequisiteProficiency: _restructure2.default.int32le,
  flags: _restructure2.default.uint32le,
  displayFlags: _restructure2.default.uint32le,
  weaponParrySequence: _restructure2.default.uint32le,
  weaponReadySequence: _restructure2.default.uint32le,
  weaponAttackSequence: _restructure2.default.uint32le,
  weaponSwingSize: _restructure2.default.uint32le,
  name: _localizedStringRef2.default,
  alternativeName: _localizedStringRef2.default
});
module.exports = exports['default'];