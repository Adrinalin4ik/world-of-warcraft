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
  leftModelFile: _stringRef2.default,
  rightModelFile: _stringRef2.default,
  leftModelTexture: _stringRef2.default,
  rightModelTexture: _stringRef2.default,
  icon: _stringRef2.default,
  iconAlt: _stringRef2.default,
  geosetGroupIDs: new r.Array(r.uint32le, 3),
  flags: r.uint32le,
  spellVisualID: r.uint32le,
  groupSoundID: r.uint32le,
  maleHelmetGeosetVisID: r.uint32le,
  femaleHelmetGeosetVisID: r.uint32le,
  upperArmTexture: _stringRef2.default,
  lowerArmTexture: _stringRef2.default,
  handsTexture: _stringRef2.default,
  upperTorsoTexture: _stringRef2.default,
  lowerTorsoTexture: _stringRef2.default,
  upperLegTexture: _stringRef2.default,
  lowerLegTexture: _stringRef2.default,
  footTexture: _stringRef2.default,
  visualID: r.uint32le,
  particleColorID: r.uint32le
});
module.exports = exports['default'];