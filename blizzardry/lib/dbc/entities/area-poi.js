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

var _types = require('../../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var Icon = new _restructure2.default.Struct({
  regular: _restructure2.default.uint32le,
  damaged: _restructure2.default.uint32le,
  destroyed: _restructure2.default.uint32le
});

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  importance: _restructure2.default.uint32le,

  neutralIcon: Icon,
  allianceIcon: Icon,
  hordeIcon: Icon,

  factionID: _restructure2.default.uint32le,
  position: _types.Vec3Float,
  mapID: _restructure2.default.uint32le,
  flags: _restructure2.default.uint32le,
  areaID: _restructure2.default.uint32le,

  name: _localizedStringRef2.default,
  description: _localizedStringRef2.default,

  worldStateID: _restructure2.default.uint32le,
  worldMapLink: _restructure2.default.uint32le
});
module.exports = exports['default'];