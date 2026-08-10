'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

var _localizedStringRef = require('../localized-string-ref');

var _localizedStringRef2 = _interopRequireDefault(_localizedStringRef);

var _stringRef = require('../string-ref');

var _stringRef2 = _interopRequireDefault(_stringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.default = (0, _entity2.default)({
  id: r.uint32le,
  internalName: _stringRef2.default,
  type: r.uint32le,
  pvp: new r.Boolean(r.uint32le),
  name: _localizedStringRef2.default,
  areaID: r.uint32le,

  hordeIntro: _localizedStringRef2.default,
  allianceIntro: _localizedStringRef2.default,

  loadingScreenID: r.uint32le,
  minimapIconScale: r.floatle,

  corpseMapID: r.int32le,
  corpseStartX: r.floatle,
  corpseStartY: r.floatle,

  timeOfDayOverride: r.int32le,
  expansionID: r.uint32le,
  maxPlayers: r.uint32le,
  numberOfPlayers: r.uint32le
});
module.exports = exports['default'];