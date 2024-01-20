'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _xtend = require('xtend');

var _xtend2 = _interopRequireDefault(_xtend);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

var DBC = new r.Struct({
  signature: new r.String(4),

  recordCount: r.uint32le,
  fieldCount: r.uint32le,
  recordSize: r.uint32le,
  stringBlockSize: r.uint32le,
  stringBlockOffset: function () {
    return 4 * 5 + this.recordCount * this.recordSize;
  },

  records: new r.Array(new r.Buffer(function () {
    return this.recordSize;
  }), function () {
    return this.recordCount;
  }),

  stringBlock: new r.Buffer(function () {
    return this.stringBlockSize;
  })
});

DBC.for = function (entity) {
  var fields = (0, _xtend2.default)(this.fields, {
    entity: function () {
      return entity;
    },
    records: new r.Array(entity, function () {
      return this.recordCount;
    })
  });
  return new r.Struct(fields);
};

exports.default = DBC;
module.exports = exports['default'];