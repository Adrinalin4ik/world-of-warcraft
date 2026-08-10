'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

var _localizedStringRef = require('../localized-string-ref');

var _localizedStringRef2 = _interopRequireDefault(_localizedStringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.default = (0, _entity2.default)({
  id: r.uint32le,
  achievementID: r.uint32le,
  type: r.uint32le,
  assetID: r.uint32le,
  quantity: r.uint32le,

  startEvent: r.uint32le,
  startAsset: r.uint32le,
  failEvent: r.uint32le,
  failAsset: r.uint32le,

  description: _localizedStringRef2.default,

  flags: r.uint32le,
  timerStartEvent: r.uint32le,
  timerAssetID: r.uint32le,
  timerTime: r.uint32le,
  order: r.uint32le
});
module.exports = exports['default'];