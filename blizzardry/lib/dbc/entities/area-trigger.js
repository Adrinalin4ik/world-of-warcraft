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
  radius: _restructure2.default.floatle,
  box: new _restructure2.default.Struct({
    length: _restructure2.default.floatle,
    width: _restructure2.default.floatle,
    height: _restructure2.default.floatle,
    yaw: _restructure2.default.floatle
  })
});
module.exports = exports['default'];