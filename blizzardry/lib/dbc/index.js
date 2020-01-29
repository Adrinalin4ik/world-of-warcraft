'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _xtend = require('xtend');

var _xtend2 = _interopRequireDefault(_xtend);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var DBC = new _restructure2.default.Struct({
  signature: new _restructure2.default.String(4),

  recordCount: _restructure2.default.uint32le,
  fieldCount: _restructure2.default.uint32le,
  recordSize: _restructure2.default.uint32le,
  stringBlockSize: _restructure2.default.uint32le,
  stringBlockOffset: function () {
    return 4 * 5 + this.recordCount * this.recordSize;
  },

  records: new _restructure2.default.Array(new _restructure2.default.Buffer(function () {
    return this.recordSize;
  }), function () {
    return this.recordCount;
  }),

  stringBlock: new _restructure2.default.Buffer(function () {
    return this.stringBlockSize;
  })
});

DBC.for = function (entity) {
  var fields = (0, _xtend2.default)(this.fields, {
    entity: function () {
      return entity;
    },
    records: new _restructure2.default.Array(entity, function () {
      return this.recordCount;
    })
  });
  return new _restructure2.default.Struct(fields);
};

exports.default = DBC;
module.exports = exports['default'];