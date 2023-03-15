"use strict";

function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var r = _interopRequireWildcard(require("restructure"));
var _chunked = _interopRequireDefault(require("../chunked"));
var _chunk = _interopRequireDefault(require("../chunked/chunk"));
var _modf = _interopRequireDefault(require("../chunked/modf"));
var _mwmo = _interopRequireDefault(require("../chunked/mwmo"));
var _skipChunk = _interopRequireDefault(require("../chunked/skip-chunk"));
var _types = require("../types");
var _mcal = _interopRequireDefault(require("./mcal"));
var _mh2o = _interopRequireDefault(require("./mh2o"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function _getRequireWildcardCache(nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || _typeof(obj) !== "object" && typeof obj !== "function") { return { "default": obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj["default"] = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
var MHDR = (0, _chunk["default"])({
  flags: r.uint32le,
  offsetMCIN: r.uint32le,
  offsetMTEX: r.uint32le,
  offsetMMDX: r.uint32le,
  offsetMMID: r.uint32le,
  offsetMWMO: r.uint32le,
  offsetMWID: r.uint32le,
  offsetMDDF: r.uint32le,
  offsetMODF: r.uint32le,
  offsetMFBO: r.uint32le,
  offsetMH2O: r.uint32le,
  offsetMTXF: r.uint32le,
  skip: new r.Reserved(r.uint32le, 4)
});
var MTEX = (0, _chunk["default"])({
  filenames: new r.Array(new r.String(null), 'size', 'bytes')
});
var MMDX = (0, _chunk["default"])({
  filenames: new r.Array(new r.String(null), 'size', 'bytes')
});
var MDDF = (0, _chunk["default"])({
  entries: new r.Array(new r.Struct({
    index: r.uint32le,
    id: r.uint32le,
    position: _types.Vec3Float,
    rotation: _types.Vec3Float,
    scale: r.uint16le,
    flags: r.uint16le,
    filename: function filename() {
      return this.parent.parent.MMDX.filenames[this.index];
    }
  }), 'size', 'bytes')
});
var MCVT = (0, _chunk["default"])({
  heights: new r.Array(r.floatle, 145)
});
var MCNR = (0, _chunk["default"])({
  normals: new r.Array(new r.Struct({
    x: r.int8,
    z: r.int8,
    y: r.int8
  }), 145),
  skip: new r.Reserved(r.uint8, 13)
});
var MCLY = (0, _chunk["default"])({
  layers: new r.Array(new r.Struct({
    textureID: r.uint32le,
    flags: r.uint32le,
    offsetMCAL: r.uint32le,
    effectID: r.int16le,
    skip: r.int16le,
    compressed: function compressed() {
      return this.flags & 0x200;
    }
  }), 'size', 'bytes')
});
var MCRF = (0, _chunk["default"])({
  MDDFs: new r.Array(r.uint32le, function () {
    return this.parent.doodadCount;
  }),
  MODFs: new r.Array(r.uint32le, function () {
    return this.parent.wmoCount;
  }),
  doodadEntries: function doodadEntries() {
    var entries = this.parent.parent.MDDF.entries;
    return this.MDDFs.map(function (id) {
      return entries[id];
    });
  },
  wmoEntries: function wmoEntries() {
    var entries = this.parent.parent.MODF.entries;
    return this.MODFs.map(function (id) {
      return entries[id];
    });
  }
});
var MCSH = (0, _chunk["default"])({
  // Incorrect size reported by MCSH in some ADTs
  actualSize: function actualSize() {
    return this.parent.sizeMCSH;
  },
  skip: new r.Reserved(r.uint8, 'actualSize')
});
var MCLQ = (0, _chunk["default"])({
  // Incorrect size reported by MCLQ in some ADTs
  actualSize: function actualSize() {
    return this.parent.sizeMCLQ - 8;
  },
  skip: new r.Reserved(r.uint8, 'actualSize')
});
var MCNK = (0, _chunk["default"])({
  flags: r.uint32le,
  indexX: r.uint32le,
  indexY: r.uint32le,
  layerCount: r.uint32le,
  doodadCount: r.uint32le,
  offsetMCVT: r.uint32le,
  offsetMCNR: r.uint32le,
  offsetMCLY: r.uint32le,
  offsetMCRF: r.uint32le,
  offsetMCAL: r.uint32le,
  sizeMCAL: r.uint32le,
  offsetMCSH: r.uint32le,
  sizeMCSH: r.uint32le,
  areaID: r.uint32le,
  wmoCount: r.uint32le,
  holes: r.uint16le,
  unknown: r.uint16le,
  textureMaps: new r.Reserved(r.uint16le, 8),
  predTex: r.uint32le,
  noEffectDoodad: r.uint32le,
  offsetMCSE: r.uint32le,
  soundEmitterCount: r.uint32le,
  offsetMCLQ: r.uint32le,
  sizeMCLQ: r.uint32le,
  position: _types.Vec3Float,
  offsetMCCV: r.uint32le,
  skip: new r.Reserved(r.uint32le, 2),
  MCVT: MCVT,
  MCCV: new r.Optional(_skipChunk["default"], function () {
    return this.offsetMCCV;
  }),
  MCNR: MCNR,
  MCLY: MCLY,
  MCRF: MCRF,
  MCSH: new r.Optional(MCSH, function () {
    return this.flags & 0x01;
  }),
  MCAL: _mcal["default"],
  MCLQ: new r.Optional(MCLQ, function () {
    return this.offsetMCLQ;
  }),
  MCSE: new r.Optional(_skipChunk["default"], function () {
    return this.offsetMCSE;
  })
});
var ADT = function ADT(_wdtFlags) {
  return (0, _chunked["default"])({
    MHDR: MHDR,
    flags: function flags() {
      return this.MHDR.flags;
    },
    wdtFlags: function wdtFlags() {
      return _wdtFlags;
    },
    MCIN: _skipChunk["default"],
    MTEX: MTEX,
    MMDX: MMDX,
    MMID: _skipChunk["default"],
    MWMO: _mwmo["default"],
    MWID: _skipChunk["default"],
    MDDF: new r.Optional(MDDF, function () {
      return this.MHDR.offsetMDDF;
    }),
    MODF: new r.Optional(_modf["default"], function () {
      return this.MHDR.offsetMODF;
    }),
    MH2O: new r.Optional(_mh2o["default"], function () {
      return this.MHDR.offsetMH2O;
    }),
    MCNKs: new r.Array(MCNK, 256),
    MFBO: new r.Optional(_skipChunk["default"], function () {
      return this.MHDR.offsetMFBO;
    }),
    MTXF: new r.Optional(_skipChunk["default"], function () {
      return this.MHDR.offsetMTXF;
    }),
    MTXP: new r.Optional(_skipChunk["default"], function () {
      return this.MHDR.offsetMTXP;
    })
  });
};
ADT.decode = function (stream) {
  return ADT().decode(stream);
};
var _default = ADT;
exports["default"] = _default;
//# sourceMappingURL=index.js.map