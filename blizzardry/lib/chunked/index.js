'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

exports.default = function (fields) {
  var definition = (0, _xtend2.default)({
    MVER: _mver2.default,
    version: function () {
      return this.MVER.version;
    }
  }, fields);
  return new _restructure2.default.Struct(definition);
};

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _xtend = require('xtend');

var _xtend2 = _interopRequireDefault(_xtend);

var _mver = require('./mver');

var _mver2 = _interopRequireDefault(_mver);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

module.exports = exports['default'];