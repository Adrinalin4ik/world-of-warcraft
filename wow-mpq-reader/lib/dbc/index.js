"use strict";

function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var r = _interopRequireWildcard(require("restructure"));
var _xtend = _interopRequireDefault(require("xtend"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function _getRequireWildcardCache(nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || _typeof(obj) !== "object" && typeof obj !== "function") { return { "default": obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj["default"] = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
var DBC = new r.Struct({
  signature: new r.String(4),
  recordCount: r.uint32le,
  fieldCount: r.uint32le,
  recordSize: r.uint32le,
  stringBlockSize: r.uint32le,
  stringBlockOffset: function stringBlockOffset() {
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
DBC["for"] = function (_entity) {
  var fields = (0, _xtend["default"])(this.fields, {
    entity: function entity() {
      return _entity;
    },
    records: new r.Array(_entity, function () {
      return this.recordCount;
    })
  });
  return new r.Struct(fields);
};
var _default = DBC;
exports["default"] = _default;
//# sourceMappingURL=index.js.map