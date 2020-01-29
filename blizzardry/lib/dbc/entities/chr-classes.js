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

  skip: new _restructure2.default.Reserved(_restructure2.default.uint32le),

  powerType: _restructure2.default.uint32le,
  petType: _restructure2.default.uint32le,

  name: _localizedStringRef2.default,
  nameFemale: _localizedStringRef2.default,
  nameMale: _localizedStringRef2.default,
  filename: _stringRef2.default,

  spellClassSet: _restructure2.default.uint32le,
  flags: _restructure2.default.uint32le,
  cameraID: _restructure2.default.uint32le,
  expansionID: _restructure2.default.uint32le
});
module.exports = exports['default'];