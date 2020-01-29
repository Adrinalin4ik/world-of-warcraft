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
  rootID: _restructure2.default.uint32le,
  nameSetID: _restructure2.default.uint32le,
  groupID: _restructure2.default.int32le,

  unknowns: new _restructure2.default.Reserved(_restructure2.default.uint32le, 5),

  flags: _restructure2.default.uint32le,
  areaID: _restructure2.default.uint32le,
  name: _localizedStringRef2.default
});
module.exports = exports['default'];