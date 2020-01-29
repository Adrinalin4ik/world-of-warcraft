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
  flags: _restructure2.default.uint32le,

  factionID: _restructure2.default.uint32le,
  explorationSoundID: _restructure2.default.uint32le,
  maleDisplayID: _restructure2.default.uint32le,
  femaleDisplayID: _restructure2.default.uint32le,

  clientPrefix: _stringRef2.default,

  skip: new _restructure2.default.Reserved(_restructure2.default.uint32le),

  baseLanguage: _restructure2.default.uint32le,
  resSicknessSpellID: _restructure2.default.uint32le,
  splashSoundID: _restructure2.default.uint32le,
  clientFileString: _stringRef2.default,
  cinematicSequenceID: _restructure2.default.uint32le,

  name: _localizedStringRef2.default,
  nameFemale: _localizedStringRef2.default,
  nameMale: _localizedStringRef2.default,

  facialHairCustomization: _stringRef2.default,
  facialHairCustomization2: _stringRef2.default,
  hairCustomization: _stringRef2.default,

  expansionID: _restructure2.default.uint32le
});
module.exports = exports['default'];