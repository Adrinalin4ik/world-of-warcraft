'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.default = (0, _entity2.default)({
  id: r.uint32le,
  gemColors: new r.Array(r.uint8, 5),
  operands: new r.Array(r.uint32le, 5),
  comparators: new r.Array(r.uint8, 5),
  compareColors: new r.Array(r.uint8, 5),
  values: new r.Array(r.uint32le, 5),
  logicalOperands: new r.Array(r.uint8, 5)
});
module.exports = exports['default'];