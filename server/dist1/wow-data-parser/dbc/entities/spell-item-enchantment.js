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
  charges: r.uint32le,
  displayTypeIDs: new r.Array(r.uint32le, 3),
  minAmounts: new r.Array(r.uint32le, 3),
  maxAmounts: new r.Array(r.uint32le, 3),
  objectIDs: new r.Array(r.uint32le, 3),
  name: _localizedStringRef2.default,
  itemVisualID: r.uint32le,
  flags: r.uint32le,
  unknown: new r.Reserved(r.uint32le),
  conditionID: r.uint32le,
  skillLineID: r.uint32le,
  skillLevel: r.uint32le,
  requiredLevel: r.uint32le
});
module.exports = exports['default'];