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

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  mapID: _restructure2.default.uint32le,
  areaID: _restructure2.default.uint32le,
  name: _stringRef2.default,
  position: new _restructure2.default.Struct({
    left: _restructure2.default.floatle,
    right: _restructure2.default.floatle,
    top: _restructure2.default.floatle,
    bottom: _restructure2.default.floatle
  }),
  displayMapID: _restructure2.default.int32le,
  defaultDungeonFloor: _restructure2.default.uint32le,
  unknown: new _restructure2.default.Reserved(_restructure2.default.uint32le)
});
module.exports = exports['default'];