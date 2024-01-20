'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _types = require('../../types');

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

var _localizedStringRef = require('../localized-string-ref');

var _localizedStringRef2 = _interopRequireDefault(_localizedStringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

var Icon = new r.Struct({
  regular: r.uint32le,
  damaged: r.uint32le,
  destroyed: r.uint32le
});

exports.default = (0, _entity2.default)({
  id: r.uint32le,
  importance: r.uint32le,

  neutralIcon: Icon,
  allianceIcon: Icon,
  hordeIcon: Icon,

  factionID: r.uint32le,
  position: _types.Vec3Float,
  mapID: r.uint32le,
  flags: r.uint32le,
  areaID: r.uint32le,

  name: _localizedStringRef2.default,
  description: _localizedStringRef2.default,

  worldStateID: r.uint32le,
  worldMapLink: r.uint32le
});
module.exports = exports['default'];