'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _chunk = require('../chunked/chunk');

var _chunk2 = _interopRequireDefault(_chunk);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

var VertexData = new r.Struct({
  vertexCount() {
    return this.parent.vertexCount;
  },

  heightMap: new r.Optional(new r.Array(r.floatle, 'vertexCount'), function () {
    // TODO: Might have to be determined via LiquidType.dbc or LiquidMaterial.dbc
    return this.parent.liquidTypeID !== 2;
  }),

  heights: function () {
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

  vertexCount: function () {
    return (this.width + 1) * (this.height + 1);
  },

  fill: new r.Pointer(r.uint32le, new r.Array(r.uint8, 'height'), {
    type: 'global',
    relativeTo: 'parent.parent.offset'
  }),

  vertexData: new r.Pointer(r.uint32le, VertexData, {
    type: 'global',
    relativeTo: 'parent.parent.offset'
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
    relativeTo: 'parent.offset'
  }),
  layerCount: r.uint32le,
  flags: new r.Pointer(r.uint32le, LiquidFlags, {
    type: 'global',
    relativeTo: 'parent.offset'
  })
});

class MH2O {

  constructor() {
    this.chunk = (0, _chunk2.default)();
    this.chunks = new r.Array(LiquidChunk, 256);
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