'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.default = (0, _entity2.default)({
  id: r.uint32le,
  tabID: r.uint32le,
  tierID: r.uint32le,
  columnIndex: r.uint32le,
  spellRankIDs: new r.Array(r.uint32le, 9),
  preqreqTalentIDs: new r.Array(r.uint32le, 3),
  preqreqRanks: new r.Array(r.uint32le, 3),
  flags: r.uint32le,
  requiredSpellID: r.uint32le,
  unknowns: new r.Reserved(r.uint32le, 2)
});
module.exports = exports['default'];