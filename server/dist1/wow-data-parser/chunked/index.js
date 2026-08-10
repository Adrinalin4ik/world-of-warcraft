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
  return new r.Struct(definition);
};

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _xtend = require('xtend');

var _xtend2 = _interopRequireDefault(_xtend);

var _mver = require('./mver');

var _mver2 = _interopRequireDefault(_mver);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

module.exports = exports['default'];