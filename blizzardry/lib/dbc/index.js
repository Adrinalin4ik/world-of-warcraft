"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _xtend = _interopRequireDefault(require("xtend"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var DBC = new _restructure["default"].Struct({
  signature: new _restructure["default"].String(4),
  recordCount: _restructure["default"].uint32le,
  fieldCount: _restructure["default"].uint32le,
  recordSize: _restructure["default"].uint32le,
  stringBlockSize: _restructure["default"].uint32le,
  stringBlockOffset: function stringBlockOffset() {
    return 4 * 5 + this.recordCount * this.recordSize;
  },
  records: new _restructure["default"].Array(new _restructure["default"].Buffer(function () {
    return this.recordSize;
  }), function () {
    return this.recordCount;
  }),
  stringBlock: new _restructure["default"].Buffer(function () {
    return this.stringBlockSize;
  })
});
DBC["for"] = function (_entity) {
  var fields = (0, _xtend["default"])(this.fields, {
    entity: function entity() {
      return _entity;
    },
    records: new _restructure["default"].Array(_entity, function () {
      return this.recordCount;
    })
  });
  return new _restructure["default"].Struct(fields);
};
var _default = DBC;
exports["default"] = _default;