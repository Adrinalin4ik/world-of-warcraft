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
  minScale: r.floatle,
  minScaleLevel: r.uint32le,
  maxScale: r.floatle,
  maxScaleLevel: r.uint32le,
  skillIDs: new r.Array(r.uint32le, 2),
  petFoodMask: r.uint32le,
  petTalentType: r.int32le,
  categoryEnumID: r.int32le,
  name: _localizedStringRef2.default,
  iconFile: _stringRef2.default
});
module.exports = exports['default'];