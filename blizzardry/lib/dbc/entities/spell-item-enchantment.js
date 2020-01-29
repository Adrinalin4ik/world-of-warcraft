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
  charges: _restructure2.default.uint32le,
  displayTypeIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  minAmounts: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  maxAmounts: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  objectIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  name: _localizedStringRef2.default,
  itemVisualID: _restructure2.default.uint32le,
  flags: _restructure2.default.uint32le,
  unknown: new _restructure2.default.Reserved(_restructure2.default.uint32le),
  conditionID: _restructure2.default.uint32le,
  skillLineID: _restructure2.default.uint32le,
  skillLevel: _restructure2.default.uint32le,
  requiredLevel: _restructure2.default.uint32le
});
module.exports = exports['default'];