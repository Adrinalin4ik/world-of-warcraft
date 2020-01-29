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
  parentKitID: _restructure2.default.uint32le,
  effectID: _restructure2.default.uint32le,
  attachmentID: _restructure2.default.uint32le,
  offset: _types.Vec3Float,
  yaw: _restructure2.default.floatle,
  pitch: _restructure2.default.floatle,
  roll: _restructure2.default.floatle
});
module.exports = exports['default'];