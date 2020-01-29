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
  file: _stringRef2.default,
  areaEffectSize: _restructure2.default.floatle,
  scale: _restructure2.default.floatle,
  minScale: _restructure2.default.floatle,
  maxScale: _restructure2.default.floatle
});
module.exports = exports['default'];