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
  type: _restructure2.default.uint32le,

  name: _stringRef2.default,
  filenames: new _restructure2.default.Array(_stringRef2.default, 10),
  unknowns: new _restructure2.default.Reserved(_stringRef2.default, 10),
  path: _stringRef2.default,

  volume: _restructure2.default.floatle,
  flags: _restructure2.default.uint32le,
  minDistance: _restructure2.default.floatle,
  distanceCutOff: _restructure2.default.floatle,
  eaxDef: _restructure2.default.uint32le,
  advancedID: _restructure2.default.uint32le
});
module.exports = exports['default'];