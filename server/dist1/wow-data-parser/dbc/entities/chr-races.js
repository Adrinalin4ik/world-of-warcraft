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
  flags: r.uint32le,

  factionID: r.uint32le,
  explorationSoundID: r.uint32le,
  maleDisplayID: r.uint32le,
  femaleDisplayID: r.uint32le,

  clientPrefix: _stringRef2.default,

  skip: new r.Reserved(r.uint32le),

  baseLanguage: r.uint32le,
  resSicknessSpellID: r.uint32le,
  splashSoundID: r.uint32le,
  clientFileString: _stringRef2.default,
  cinematicSequenceID: r.uint32le,

  name: _localizedStringRef2.default,
  nameFemale: _localizedStringRef2.default,
  nameMale: _localizedStringRef2.default,

  facialHairCustomization: _stringRef2.default,
  facialHairCustomization2: _stringRef2.default,
  hairCustomization: _stringRef2.default,

  expansionID: r.uint32le
});
module.exports = exports['default'];