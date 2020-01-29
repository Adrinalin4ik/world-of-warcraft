'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

var _stringRef = require('../string-ref');

var _stringRef2 = _interopRequireDefault(_stringRef);

var _types = require('../../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  file: _stringRef2.default,
  soundIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 10),
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  objectEffectPackageID: _restructure2.default.uint32le
});
module.exports = exports['default'];