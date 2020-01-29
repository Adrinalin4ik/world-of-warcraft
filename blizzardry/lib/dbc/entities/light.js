'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

var _types = require('../../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  mapID: _restructure2.default.uint32le,
  position: _types.Vec3Float,
  fallOffStart: _restructure2.default.floatle,
  fallOffEnd: _restructure2.default.floatle,
  skyFogID: _restructure2.default.uint32le,
  waterID: _restructure2.default.uint32le,
  sunsetID: _restructure2.default.uint32le,
  otherID: _restructure2.default.uint32le,
  deathID: _restructure2.default.uint32le,
  unknowns: new _restructure2.default.Reserved(_restructure2.default.uint32le, 3)
});
module.exports = exports['default'];