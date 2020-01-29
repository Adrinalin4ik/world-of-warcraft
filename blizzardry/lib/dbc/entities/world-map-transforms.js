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
  mapID: _restructure2.default.uint32le,
  regionMinX: _restructure2.default.floatle,
  regionMinY: _restructure2.default.floatle,
  regionMaxX: _restructure2.default.floatle,
  regionMaxY: _restructure2.default.floatle,
  newMapID: _restructure2.default.uint32le,
  regionOffsetX: _restructure2.default.floatle,
  regionOffsetY: _restructure2.default.floatle,
  unknown: new _restructure2.default.Reserved(_restructure2.default.uint32le)
});
module.exports = exports['default'];