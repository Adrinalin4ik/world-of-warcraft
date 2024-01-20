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

  skip: new r.Reserved(r.uint32le),

  powerType: r.uint32le,
  petType: r.uint32le,

  name: _localizedStringRef2.default,
  nameFemale: _localizedStringRef2.default,
  nameMale: _localizedStringRef2.default,
  filename: _stringRef2.default,

  spellClassSet: r.uint32le,
  flags: r.uint32le,
  cameraID: r.uint32le,
  expansionID: r.uint32le
});
module.exports = exports['default'];