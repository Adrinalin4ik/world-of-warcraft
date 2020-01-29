'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

exports.default = function (fields) {
  var entity = new _restructure2.default.Struct(fields);
  entity.dbc = _2.default.for(entity);
  return entity;
};

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _ = require('./');

var _2 = _interopRequireDefault(_);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

module.exports = exports['default'];