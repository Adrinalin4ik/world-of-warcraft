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
  tabID: _restructure2.default.uint32le,
  tierID: _restructure2.default.uint32le,
  columnIndex: _restructure2.default.uint32le,
  spellRankIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 9),
  preqreqTalentIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  preqreqRanks: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  flags: _restructure2.default.uint32le,
  requiredSpellID: _restructure2.default.uint32le,
  unknowns: new _restructure2.default.Reserved(_restructure2.default.uint32le, 2)
});
module.exports = exports['default'];