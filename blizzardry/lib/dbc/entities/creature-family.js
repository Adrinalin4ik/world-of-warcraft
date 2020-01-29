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

var _stringRef = require('../string-ref');

var _stringRef2 = _interopRequireDefault(_stringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  minScale: _restructure2.default.floatle,
  minScaleLevel: _restructure2.default.uint32le,
  maxScale: _restructure2.default.floatle,
  maxScaleLevel: _restructure2.default.uint32le,
  skillIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 2),
  petFoodMask: _restructure2.default.uint32le,
  petTalentType: _restructure2.default.int32le,
  categoryEnumID: _restructure2.default.int32le,
  name: _localizedStringRef2.default,
  iconFile: _stringRef2.default
});
module.exports = exports['default'];