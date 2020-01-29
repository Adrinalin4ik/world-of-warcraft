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
  silenceIntervalMinDay: _restructure2.default.uint32le,
  silenceIntervalMinNight: _restructure2.default.uint32le,
  silenceIntervalMaxDay: _restructure2.default.uint32le,
  silenceIntervalMaxNight: _restructure2.default.uint32le,
  dayMusicID: _restructure2.default.uint32le,
  nightMusicID: _restructure2.default.uint32le
});
module.exports = exports['default'];