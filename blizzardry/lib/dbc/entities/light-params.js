'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  highlightSky: new _restructure2.default.Boolean(_restructure2.default.uint32le),
  lightSkyboxID: _restructure2.default.uint32le,
  glow: _restructure2.default.floatle,
  waterShallowAlpha: _restructure2.default.floatle,
  waterDeepAlpha: _restructure2.default.floatle,
  oceanShallowAlpha: _restructure2.default.floatle,
  oceanDeepAlpha: _restructure2.default.floatle,
  flags: _restructure2.default.uint32le
});
module.exports = exports['default'];