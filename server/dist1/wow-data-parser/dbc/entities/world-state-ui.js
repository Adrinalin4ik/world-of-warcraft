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

var _stringRef = require('../string-ref');

var _stringRef2 = _interopRequireDefault(_stringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.default = (0, _entity2.default)({
  id: r.uint32le,
  mapID: r.int32le,
  zoneID: r.uint32le,
  phase: r.uint32le,
  text: _localizedStringRef2.default,
  description: _localizedStringRef2.default,
  state: r.int32le,
  worldState: r.uint32le,
  type: r.uint32le,
  icon: _stringRef2.default,
  tooltip: _localizedStringRef2.default,
  ui: _stringRef2.default,
  stateVariables: new r.Array(r.uint32le, 3)
});
module.exports = exports['default'];