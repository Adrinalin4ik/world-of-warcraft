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
  name: _stringRef2.default,
  flags: _restructure2.default.uint32le,
  type: _restructure2.default.uint32le,
  soundEntryID: _restructure2.default.uint32le,
  spellID: _restructure2.default.uint32le,
  maxDarkenDepth: _restructure2.default.floatle,
  fogDarkenIntensity: _restructure2.default.floatle,
  ambDarkenIntensity: _restructure2.default.floatle,
  dirDarkenIntensity: _restructure2.default.floatle,
  lightID: _restructure2.default.uint32le,
  particleScale: _restructure2.default.floatle,
  particleMovement: _restructure2.default.uint32le,
  particleTexSlots: _restructure2.default.uint32le,
  liquidMaterialID: _restructure2.default.uint32le,
  textures: new _restructure2.default.Array(_stringRef2.default, 6),
  colors: new _restructure2.default.Array(_restructure2.default.uint32le, 2),
  shaderFloatAttributes: new _restructure2.default.Array(_restructure2.default.floatle, 18),
  shaderIntAttributes: new _restructure2.default.Array(_restructure2.default.uint32le, 4)
});
module.exports = exports['default'];