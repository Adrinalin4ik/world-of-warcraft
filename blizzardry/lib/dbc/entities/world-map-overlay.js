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

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  mapAreaID: _restructure2.default.uint32le,
  areaIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 4),
  mapPointX: _restructure2.default.uint32le,
  mapPointY: _restructure2.default.uint32le,
  textureName: _stringRef2.default,
  textureWidth: _restructure2.default.uint32le,
  textureHeight: _restructure2.default.uint32le,
  offsetX: _restructure2.default.uint32le,
  offsetY: _restructure2.default.uint32le,
  bounds: new _restructure2.default.Struct({
    top: _restructure2.default.uint32le,
    left: _restructure2.default.uint32le,
    bottom: _restructure2.default.uint32le,
    right: _restructure2.default.uint32le
  })
});
module.exports = exports['default'];