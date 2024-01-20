'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _types = require('../../types');

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.default = (0, _entity2.default)({
  id: r.uint32le,
  mapID: r.uint32le,
  position: _types.Vec3Float,
  fallOffStart: r.floatle,
  fallOffEnd: r.floatle,
  skyFogID: r.uint32le,
  waterID: r.uint32le,
  sunsetID: r.uint32le,
  otherID: r.uint32le,
  deathID: r.uint32le,
  unknowns: new r.Reserved(r.uint32le, 3)
});
module.exports = exports['default'];