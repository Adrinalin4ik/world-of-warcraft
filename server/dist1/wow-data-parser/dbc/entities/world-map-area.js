'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

var _stringRef = require('../string-ref');

var _stringRef2 = _interopRequireDefault(_stringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.default = (0, _entity2.default)({
  id: r.uint32le,
  mapID: r.uint32le,
  areaID: r.uint32le,
  name: _stringRef2.default,
  position: new r.Struct({
    left: r.floatle,
    right: r.floatle,
    top: r.floatle,
    bottom: r.floatle
  }),
  displayMapID: r.int32le,
  defaultDungeonFloor: r.uint32le,
  unknown: new r.Reserved(r.uint32le)
});
module.exports = exports['default'];