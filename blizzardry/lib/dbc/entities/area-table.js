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

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  mapID: _restructure2.default.uint32le,
  parentID: _restructure2.default.uint32le,
  areaBit: _restructure2.default.uint32le,
  flags: _restructure2.default.uint32le,

  soundPreferenceID: _restructure2.default.uint32le,
  underwaterSoundPreferenceID: _restructure2.default.uint32le,
  soundAmbienceID: _restructure2.default.uint32le,
  zoneMusicID: _restructure2.default.uint32le,
  zoneIntroMusicID: _restructure2.default.uint32le,

  level: _restructure2.default.uint32le,
  name: _localizedStringRef2.default,
  factionGroupID: _restructure2.default.uint32le,
  liquidTypes: new _restructure2.default.Array(_restructure2.default.uint32le, 4),
  minElevation: _restructure2.default.floatle,
  ambientMultiplier: _restructure2.default.floatle,
  lightID: _restructure2.default.uint32le
});
module.exports = exports['default'];