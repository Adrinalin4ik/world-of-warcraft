"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _chunk = _interopRequireDefault(require("../chunked/chunk"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _toPropertyKey(arg) { var key = _toPrimitive(arg, "string"); return _typeof(key) === "symbol" ? key : String(key); }
function _toPrimitive(input, hint) { if (_typeof(input) !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (_typeof(res) !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }
var VertexData = new _restructure["default"].Struct({
  vertexCount: function vertexCount() {
    return this.parent.vertexCount;
  },
  heightMap: new _restructure["default"].Optional(new _restructure["default"].Array(_restructure["default"].floatle, 'vertexCount'), function () {
    // TODO: Might have to be determined via LiquidType.dbc or LiquidMaterial.dbc
    return this.parent.liquidTypeID !== 2;
  }),
  heights: function heights() {
    var defaultHeight = this.parent.maxHeightLevel;
    return this.heightMap || new Array(this.vertexCount).fill(defaultHeight);
  },
  alphas: new _restructure["default"].Array(_restructure["default"].uint8, 'vertexCount')
});
var LiquidLayer = new _restructure["default"].Struct({
  liquidTypeID: _restructure["default"].uint16le,
  liquidObjectID: _restructure["default"].uint16le,
  minHeightLevel: _restructure["default"].floatle,
  maxHeightLevel: _restructure["default"].floatle,
  offsetX: _restructure["default"].uint8,
  offsetY: _restructure["default"].uint8,
  width: _restructure["default"].uint8,
  height: _restructure["default"].uint8,
  vertexCount: function vertexCount() {
    return (this.width + 1) * (this.height + 1);
  },
  fill: new _restructure["default"].Pointer(_restructure["default"].uint32le, new _restructure["default"].Array(_restructure["default"].uint8, 'height'), {
    type: 'global',
    relativeTo: function relativeTo() {
      return 'parent.parent.offset';
    }
  }),
  vertexData: new _restructure["default"].Pointer(_restructure["default"].uint32le, VertexData, {
    type: 'global',
    relativeTo: function relativeTo() {
      return 'parent.parent.offset';
    }
  })
});
var LiquidFlags = new _restructure["default"].Struct({
  fishable: new _restructure["default"].Array(_restructure["default"].uint8, 8),
  deep: new _restructure["default"].Array(_restructure["default"].uint8, 8)
});
var LiquidChunk = new _restructure["default"].Struct({
  layers: new _restructure["default"].Pointer(_restructure["default"].uint32le, new _restructure["default"].Array(LiquidLayer, 'layerCount'), {
    type: 'global',
    lazy: true,
    relativeTo: function relativeTo() {
      return 'parent.offset';
    }
  }),
  layerCount: _restructure["default"].uint32le,
  flags: new _restructure["default"].Pointer(_restructure["default"].uint32le, LiquidFlags, {
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
    this.chunks = new _restructure["default"].Array(LiquidChunk, 256);
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