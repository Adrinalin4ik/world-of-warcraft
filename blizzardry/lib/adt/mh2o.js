'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _chunk = require('../chunked/chunk');

var _chunk2 = _interopRequireDefault(_chunk);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var VertexData = new _restructure2.default.Struct({
  vertexCount() {
    return this.parent.vertexCount;
  },

  heightMap: new _restructure2.default.Optional(new _restructure2.default.Array(_restructure2.default.floatle, 'vertexCount'), function () {
    // TODO: Might have to be determined via LiquidType.dbc or LiquidMaterial.dbc
    return this.parent.liquidTypeID !== 2;
  }),

  heights: function () {
    var defaultHeight = this.parent.maxHeightLevel;
    return this.heightMap || new Array(this.vertexCount).fill(defaultHeight);
  },

  alphas: new _restructure2.default.Array(_restructure2.default.uint8, 'vertexCount')
});

var LiquidLayer = new _restructure2.default.Struct({
  liquidTypeID: _restructure2.default.uint16le,
  liquidObjectID: _restructure2.default.uint16le,

  minHeightLevel: _restructure2.default.floatle,
  maxHeightLevel: _restructure2.default.floatle,

  offsetX: _restructure2.default.uint8,
  offsetY: _restructure2.default.uint8,
  width: _restructure2.default.uint8,
  height: _restructure2.default.uint8,

  vertexCount: function () {
    return (this.width + 1) * (this.height + 1);
  },

  fill: new _restructure2.default.Pointer(_restructure2.default.uint32le, new _restructure2.default.Array(_restructure2.default.uint8, 'height'), {
    type: 'global',
    relativeTo: 'parent.parent.offset'
  }),

  vertexData: new _restructure2.default.Pointer(_restructure2.default.uint32le, VertexData, {
    type: 'global',
    relativeTo: 'parent.parent.offset'
  })
});

var LiquidFlags = new _restructure2.default.Struct({
  fishable: new _restructure2.default.Array(_restructure2.default.uint8, 8),
  deep: new _restructure2.default.Array(_restructure2.default.uint8, 8)
});

var LiquidChunk = new _restructure2.default.Struct({
  layers: new _restructure2.default.Pointer(_restructure2.default.uint32le, new _restructure2.default.Array(LiquidLayer, 'layerCount'), {
    type: 'global',
    lazy: true,
    relativeTo: 'parent.offset'
  }),
  layerCount: _restructure2.default.uint32le,
  flags: new _restructure2.default.Pointer(_restructure2.default.uint32le, LiquidFlags, {
    type: 'global',
    relativeTo: 'parent.offset'
  })
});

class MH2O {

  constructor() {
    this.chunk = (0, _chunk2.default)();
    this.chunks = new _restructure2.default.Array(LiquidChunk, 256);
  }

  decode(stream, parent) {
    var data = this.chunk.decode(stream, parent);
    var pos = stream.pos;

    // Used to correctly resolve pointers within MH2O chunk
    parent.offset = pos;

    data.chunks = this.chunks.decode(stream, parent);

    stream.pos = pos + data.size;
    return data;
  }

}

exports.default = new MH2O();
module.exports = exports['default'];