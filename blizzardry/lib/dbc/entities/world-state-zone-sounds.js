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
  value: _restructure2.default.uint32le,
  areaID: _restructure2.default.uint32le,
  wmoAreaID: _restructure2.default.uint32le,
  introMusicID: _restructure2.default.uint32le,
  musicID: _restructure2.default.uint32le,
  soundAmbienceID: _restructure2.default.uint32le,
  soundProviderPreferenceID: _restructure2.default.uint32le
});
module.exports = exports['default'];