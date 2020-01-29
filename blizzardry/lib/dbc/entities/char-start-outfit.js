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
  raceID: _restructure2.default.uint8,
  classID: _restructure2.default.uint8,
  gender: _restructure2.default.uint8,
  outfitID: _restructure2.default.uint8,

  itemIDs: new _restructure2.default.Array(_restructure2.default.int32le, 24),
  displayInfoIDs: new _restructure2.default.Array(_restructure2.default.int32le, 24),
  inventoryTypes: new _restructure2.default.Array(_restructure2.default.int32le, 24)
});
module.exports = exports['default'];