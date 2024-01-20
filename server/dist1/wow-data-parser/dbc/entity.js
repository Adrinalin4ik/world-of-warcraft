'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

exports.default = function (fields) {
  var entity = new r.Struct(fields);
  entity.dbc = _2.default.for(entity);
  return entity;
};

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _ = require('./');

var _2 = _interopRequireDefault(_);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

module.exports = exports['default'];