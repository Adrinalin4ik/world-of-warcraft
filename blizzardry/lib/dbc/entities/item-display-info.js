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
  leftModelFile: _stringRef2.default,
  rightModelFile: _stringRef2.default,
  leftModelTexture: _stringRef2.default,
  rightModelTexture: _stringRef2.default,
  icon: _stringRef2.default,
  iconAlt: _stringRef2.default,
  geosetGroupIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  flags: _restructure2.default.uint32le,
  spellVisualID: _restructure2.default.uint32le,
  groupSoundID: _restructure2.default.uint32le,
  maleHelmetGeosetVisID: _restructure2.default.uint32le,
  femaleHelmetGeosetVisID: _restructure2.default.uint32le,
  upperArmTexture: _stringRef2.default,
  lowerArmTexture: _stringRef2.default,
  handsTexture: _stringRef2.default,
  upperTorsoTexture: _stringRef2.default,
  lowerTorsoTexture: _stringRef2.default,
  upperLegTexture: _stringRef2.default,
  lowerLegTexture: _stringRef2.default,
  footTexture: _stringRef2.default,
  visualID: _restructure2.default.uint32le,
  particleColorID: _restructure2.default.uint32le
});
module.exports = exports['default'];