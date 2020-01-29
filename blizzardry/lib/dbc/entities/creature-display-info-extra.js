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
  raceID: _restructure2.default.uint32le,
  gender: _restructure2.default.uint32le,

  skinColor: _restructure2.default.uint32le,
  faceType: _restructure2.default.uint32le,
  hairType: _restructure2.default.uint32le,
  hairStyle: _restructure2.default.uint32le,
  beardStyle: _restructure2.default.uint32le,

  helmID: _restructure2.default.uint32le,
  shoulderID: _restructure2.default.uint32le,
  shirtID: _restructure2.default.uint32le,
  cuirassID: _restructure2.default.uint32le,
  beltID: _restructure2.default.uint32le,
  legsID: _restructure2.default.uint32le,
  bootsID: _restructure2.default.uint32le,
  wristID: _restructure2.default.uint32le,
  glovesID: _restructure2.default.uint32le,
  tabardID: _restructure2.default.uint32le,
  capeID: _restructure2.default.uint32le,

  canEquip: new _restructure2.default.Boolean(_restructure2.default.uint32le),
  texture: _stringRef2.default
});
module.exports = exports['default'];