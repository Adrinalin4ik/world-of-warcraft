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

var _types = require('../../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  name: _stringRef2.default,
  effectGroupID: _restructure2.default.uint32le,
  triggerType: _restructure2.default.uint32le,
  eventType: _restructure2.default.uint32le,
  effectRecType: _restructure2.default.uint32le,
  effectRecID: _restructure2.default.uint32le,
  attachment: _restructure2.default.uint32le,
  offset: _types.Vec3Float,
  effectModifierID: _restructure2.default.uint32le
});
module.exports = exports['default'];