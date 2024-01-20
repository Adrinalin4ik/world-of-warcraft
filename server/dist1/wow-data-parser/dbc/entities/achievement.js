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
  faction: r.int32le,
  mapID: r.int32le,
  previousID: r.uint32le,
  name: _localizedStringRef2.default,
  description: _localizedStringRef2.default,
  categoryID: r.uint32le,
  points: r.uint32le,
  order: r.uint32le,
  flags: r.uint32le,
  spellIconID: r.uint32le,
  reward: _localizedStringRef2.default,
  minimumCriteria: r.uint32le,
  criteriaTreeID: r.uint32le
});
module.exports = exports['default'];