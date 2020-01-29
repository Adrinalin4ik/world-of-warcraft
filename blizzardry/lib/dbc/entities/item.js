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
  classID: _restructure2.default.uint32le,
  subClassID: _restructure2.default.uint32le,
  soundOverrideSubClassID: _restructure2.default.int32le,
  materialID: _restructure2.default.uint32le,
  displayInfoID: _restructure2.default.uint32le,
  inventorySlotID: _restructure2.default.uint32le,
  sheathID: _restructure2.default.uint32le
});
module.exports = exports['default'];