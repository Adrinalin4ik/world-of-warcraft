'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _types = require('../../types');

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

var _stringRef = require('../string-ref');

var _stringRef2 = _interopRequireDefault(_stringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.default = (0, _entity2.default)({
  id: r.uint32le,
  name: _stringRef2.default,
  effectGroupID: r.uint32le,
  triggerType: r.uint32le,
  eventType: r.uint32le,
  effectRecType: r.uint32le,
  effectRecID: r.uint32le,
  attachment: r.uint32le,
  offset: _types.Vec3Float,
  effectModifierID: r.uint32le
});
module.exports = exports['default'];