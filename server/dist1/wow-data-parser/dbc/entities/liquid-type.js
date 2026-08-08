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
  name: _stringRef2.default,
  flags: r.uint32le,
  type: r.uint32le,
  soundEntryID: r.uint32le,
  spellID: r.uint32le,
  maxDarkenDepth: r.floatle,
  fogDarkenIntensity: r.floatle,
  ambDarkenIntensity: r.floatle,
  dirDarkenIntensity: r.floatle,
  lightID: r.uint32le,
  particleScale: r.floatle,
  particleMovement: r.uint32le,
  particleTexSlots: r.uint32le,
  liquidMaterialID: r.uint32le,
  textures: new r.Array(_stringRef2.default, 6),
  colors: new r.Array(r.uint32le, 2),
  shaderFloatAttributes: new r.Array(r.floatle, 18),
  shaderIntAttributes: new r.Array(r.uint32le, 4)
});
module.exports = exports['default'];