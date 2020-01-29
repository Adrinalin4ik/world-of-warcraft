'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

var _localizedStringRef = require('../localized-string-ref');

var _localizedStringRef2 = _interopRequireDefault(_localizedStringRef);

var _stringRef = require('../string-ref');

var _stringRef2 = _interopRequireDefault(_stringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  internalName: _stringRef2.default,
  type: _restructure2.default.uint32le,
  pvp: new _restructure2.default.Boolean(_restructure2.default.uint32le),
  name: _localizedStringRef2.default,
  areaID: _restructure2.default.uint32le,

  hordeIntro: _localizedStringRef2.default,
  allianceIntro: _localizedStringRef2.default,

  loadingScreenID: _restructure2.default.uint32le,
  minimapIconScale: _restructure2.default.floatle,

  corpseMapID: _restructure2.default.int32le,
  corpseStartX: _restructure2.default.floatle,
  corpseStartY: _restructure2.default.floatle,

  timeOfDayOverride: _restructure2.default.int32le,
  expansionID: _restructure2.default.uint32le,
  maxPlayers: _restructure2.default.uint32le,
  numberOfPlayers: _restructure2.default.uint32le
});
module.exports = exports['default'];