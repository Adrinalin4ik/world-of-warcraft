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
  bounds: new _restructure2.default.Struct({
    left: _restructure2.default.uint32le,
    right: _restructure2.default.uint32le,
    top: _restructure2.default.uint32le,
    bottom: _restructure2.default.uint32le
  }),
  offsetX: _restructure2.default.floatle,
  offsetY: _restructure2.default.floatle,
  scale: _restructure2.default.floatle,
  taxiMinX: _restructure2.default.floatle,
  taxiMinY: _restructure2.default.floatle,
  taxiMaxX: _restructure2.default.floatle,
  taxiMaxY: _restructure2.default.floatle,
  worldMapID: _restructure2.default.uint32le
});
module.exports = exports['default'];