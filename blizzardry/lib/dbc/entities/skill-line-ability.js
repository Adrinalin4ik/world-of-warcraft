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
  skillLineID: _restructure2.default.uint32le,
  spellID: _restructure2.default.uint32le,

  requiredRaces: _restructure2.default.uint32le,
  requiredClasses: _restructure2.default.uint32le,
  excludedRaces: _restructure2.default.uint32le,
  excludedClasses: _restructure2.default.uint32le,

  minRank: _restructure2.default.uint32le,
  parentSpellID: _restructure2.default.uint32le,

  acquireMethod: _restructure2.default.uint32le,

  greyLevel: _restructure2.default.uint32le,
  yellowLevel: _restructure2.default.uint32le,

  charactersPoints: new _restructure2.default.Array(_restructure2.default.uint32le, 2)
});
module.exports = exports['default'];