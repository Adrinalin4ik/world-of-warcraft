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
  spellIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 4),
  cooldowns: new _restructure2.default.Array(_restructure2.default.uint32le, 4)
});
module.exports = exports['default'];