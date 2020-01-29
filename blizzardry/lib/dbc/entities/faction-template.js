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
  factionID: _restructure2.default.uint32le,
  unknown: new _restructure2.default.Reserved(_restructure2.default.uint32le),
  groupMask: _restructure2.default.uint32le,
  friendlyMask: _restructure2.default.uint32le,
  hostileMask: _restructure2.default.uint32le,
  relatedFactionIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 8)
});
module.exports = exports['default'];