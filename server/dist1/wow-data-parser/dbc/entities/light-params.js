'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.default = (0, _entity2.default)({
  id: r.uint32le,
  highlightSky: new r.Boolean(r.uint32le),
  lightSkyboxID: r.uint32le,
  glow: r.floatle,
  waterShallowAlpha: r.floatle,
  waterDeepAlpha: r.floatle,
  oceanShallowAlpha: r.floatle,
  oceanDeepAlpha: r.floatle,
  flags: r.uint32le
});
module.exports = exports['default'];