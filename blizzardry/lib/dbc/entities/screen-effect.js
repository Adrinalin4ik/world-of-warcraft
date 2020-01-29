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
  name: _stringRef2.default,
  type: _restructure2.default.uint32le,
  rgba: new _restructure2.default.Array(_restructure2.default.uint8, 4),
  edge: _restructure2.default.uint32le,
  bw: _restructure2.default.uint32le,
  unknown: new _restructure2.default.Reserved(_restructure2.default.uint32le),
  lightParamsID: _restructure2.default.int32le,
  soundAmbienceID: _restructure2.default.uint32le,
  zoneMusicID: _restructure2.default.uint32le
});
module.exports = exports['default'];