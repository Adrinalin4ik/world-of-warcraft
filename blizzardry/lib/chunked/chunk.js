'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

exports.default = function (fields) {
  var definition = (0, _xtend2.default)({
    id: new _restructure2.default.String(4),
    size: _restructure2.default.uint32le
  }, fields);
  return new _restructure2.default.Struct(definition);
};

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _xtend = require('xtend');

var _xtend2 = _interopRequireDefault(_xtend);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

module.exports = exports['default'];