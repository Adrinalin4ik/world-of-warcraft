'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

var _stringRef = require('../string-ref');

var _stringRef2 = _interopRequireDefault(_stringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.default = (0, _entity2.default)({
  id: r.uint32le,
  raceID: r.uint32le,
  gender: r.uint32le,

  skinColor: r.uint32le,
  faceType: r.uint32le,
  hairType: r.uint32le,
  hairStyle: r.uint32le,
  beardStyle: r.uint32le,

  helmID: r.uint32le,
  shoulderID: r.uint32le,
  shirtID: r.uint32le,
  cuirassID: r.uint32le,
  beltID: r.uint32le,
  legsID: r.uint32le,
  bootsID: r.uint32le,
  wristID: r.uint32le,
  glovesID: r.uint32le,
  tabardID: r.uint32le,
  capeID: r.uint32le,

  canEquip: new r.Boolean(r.uint32le),
  texture: _stringRef2.default
});
module.exports = exports['default'];