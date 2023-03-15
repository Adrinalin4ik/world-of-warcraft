"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var r = _interopRequireWildcard(require("restructure"));
var _chunk = _interopRequireDefault(require("../chunked/chunk"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function _getRequireWildcardCache(nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || _typeof(obj) !== "object" && typeof obj !== "function") { return { "default": obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj["default"] = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _toPropertyKey(arg) { var key = _toPrimitive(arg, "string"); return _typeof(key) === "symbol" ? key : String(key); }
function _toPrimitive(input, hint) { if (_typeof(input) !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (_typeof(res) !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }
var VertexData = new r.Struct({
  vertexCount: function vertexCount() {
    return this.parent.vertexCount;
  },
  heightMap: new r.Optional(new r.Array(r.floatle, 'vertexCount'), function () {
    // TODO: Might have to be determined via LiquidType.dbc or LiquidMaterial.dbc
    return this.parent.liquidTypeID !== 2;
  }),
  heights: function heights() {
    var defaultHeight = this.parent.maxHeightLevel;
    return this.heightMap || new Array(this.vertexCount).fill(defaultHeight);
  },
  alphas: new r.Array(r.uint8, 'vertexCount')
});
var LiquidLayer = new r.Struct({
  liquidTypeID: r.uint16le,
  liquidObjectID: r.uint16le,
  minHeightLevel: r.floatle,
  maxHeightLevel: r.floatle,
  offsetX: r.uint8,
  offsetY: r.uint8,
  width: r.uint8,
  height: r.uint8,
  vertexCount: function vertexCount() {
    return (this.width + 1) * (this.height + 1);
  },
  fill: new r.Pointer(r.uint32le, new r.Array(r.uint8, 'height'), {
    type: 'global',
    relativeTo: function relativeTo() {
      return 'parent.parent.offset';
    }
  }),
  vertexData: new r.Pointer(r.uint32le, VertexData, {
    type: 'global',
    relativeTo: function relativeTo() {
      return 'parent.parent.offset';
    }
  })
});
var LiquidFlags = new r.Struct({
  fishable: new r.Array(r.uint8, 8),
  deep: new r.Array(r.uint8, 8)
});
var LiquidChunk = new r.Struct({
  layers: new r.Pointer(r.uint32le, new r.Array(LiquidLayer, 'layerCount'), {
    type: 'global',
    lazy: true,
    relativeTo: function relativeTo() {
      return 'parent.offset';
    }
  }),
  layerCount: r.uint32le,
  flags: new r.Pointer(r.uint32le, LiquidFlags, {
    type: 'global',
    relativeTo: function relativeTo() {
      return 'parent.offset';
    }
  })
});
var MH2O = /*#__PURE__*/function () {
  function MH2O() {
    _classCallCheck(this, MH2O);
    this.chunk = (0, _chunk["default"])();
    this.chunks = new r.Array(LiquidChunk, 256);
  }
  _createClass(MH2O, [{
    key: "decode",
    value: function decode(stream, parent) {
      var data = this.chunk.decode(stream, parent);
      var pos = stream.pos;

      // Used to correctly resolve pointers within MH2O chunk
      parent.offset = pos;
      data.chunks = this.chunks.decode(stream, parent);
      stream.pos = pos + data.size;
      return data;
    }
  }]);
  return MH2O;
}();
var _default = new MH2O();
exports["default"] = _default;
//# sourceMappingURL=mh2o.js.map