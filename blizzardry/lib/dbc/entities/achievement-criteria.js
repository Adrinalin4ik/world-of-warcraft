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

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  achievementID: _restructure2.default.uint32le,
  type: _restructure2.default.uint32le,
  assetID: _restructure2.default.uint32le,
  quantity: _restructure2.default.uint32le,

  startEvent: _restructure2.default.uint32le,
  startAsset: _restructure2.default.uint32le,
  failEvent: _restructure2.default.uint32le,
  failAsset: _restructure2.default.uint32le,

  description: _localizedStringRef2.default,

  flags: _restructure2.default.uint32le,
  timerStartEvent: _restructure2.default.uint32le,
  timerAssetID: _restructure2.default.uint32le,
  timerTime: _restructure2.default.uint32le,
  order: _restructure2.default.uint32le
});
module.exports = exports['default'];