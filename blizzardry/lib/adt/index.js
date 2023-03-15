"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _chunk = _interopRequireDefault(require("../chunked/chunk"));
var _chunked = _interopRequireDefault(require("../chunked"));
var _mcal = _interopRequireDefault(require("./mcal"));
var _modf = _interopRequireDefault(require("../chunked/modf"));
var _mwmo = _interopRequireDefault(require("../chunked/mwmo"));
var _mh2o = _interopRequireDefault(require("./mh2o"));
var _skipChunk = _interopRequireDefault(require("../chunked/skip-chunk"));
var _types = require("../types");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var MHDR = (0, _chunk["default"])({
  flags: _restructure["default"].uint32le,
  offsetMCIN: _restructure["default"].uint32le,
  offsetMTEX: _restructure["default"].uint32le,
  offsetMMDX: _restructure["default"].uint32le,
  offsetMMID: _restructure["default"].uint32le,
  offsetMWMO: _restructure["default"].uint32le,
  offsetMWID: _restructure["default"].uint32le,
  offsetMDDF: _restructure["default"].uint32le,
  offsetMODF: _restructure["default"].uint32le,
  offsetMFBO: _restructure["default"].uint32le,
  offsetMH2O: _restructure["default"].uint32le,
  offsetMTXF: _restructure["default"].uint32le,
  skip: new _restructure["default"].Reserved(_restructure["default"].uint32le, 4)
});
var MTEX = (0, _chunk["default"])({
  filenames: new _restructure["default"].Array(new _restructure["default"].String(null), 'size', 'bytes')
});
var MMDX = (0, _chunk["default"])({
  filenames: new _restructure["default"].Array(new _restructure["default"].String(null), 'size', 'bytes')
});
var MDDF = (0, _chunk["default"])({
  entries: new _restructure["default"].Array(new _restructure["default"].Struct({
    index: _restructure["default"].uint32le,
    id: _restructure["default"].uint32le,
    position: _types.Vec3Float,
    rotation: _types.Vec3Float,
    scale: _restructure["default"].uint16le,
    flags: _restructure["default"].uint16le,
    filename: function filename() {
      return this.parent.parent.MMDX.filenames[this.index];
    }
  }), 'size', 'bytes')
});
var MCVT = (0, _chunk["default"])({
  heights: new _restructure["default"].Array(_restructure["default"].floatle, 145)
});
var MCNR = (0, _chunk["default"])({
  normals: new _restructure["default"].Array(new _restructure["default"].Struct({
    x: _restructure["default"].int8,
    z: _restructure["default"].int8,
    y: _restructure["default"].int8
  }), 145),
  skip: new _restructure["default"].Reserved(_restructure["default"].uint8, 13)
});
var MCLY = (0, _chunk["default"])({
  layers: new _restructure["default"].Array(new _restructure["default"].Struct({
    textureID: _restructure["default"].uint32le,
    flags: _restructure["default"].uint32le,
    offsetMCAL: _restructure["default"].uint32le,
    effectID: _restructure["default"].int16le,
    skip: _restructure["default"].int16le,
    compressed: function compressed() {
      return this.flags & 0x200;
    }
  }), 'size', 'bytes')
});
var MCRF = (0, _chunk["default"])({
  MDDFs: new _restructure["default"].Array(_restructure["default"].uint32le, function () {
    return this.parent.doodadCount;
  }),
  MODFs: new _restructure["default"].Array(_restructure["default"].uint32le, function () {
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
  skip: new _restructure["default"].Reserved(_restructure["default"].uint8, 'actualSize')
});
var MCLQ = (0, _chunk["default"])({
  // Incorrect size reported by MCLQ in some ADTs
  actualSize: function actualSize() {
    return this.parent.sizeMCLQ - 8;
  },
  skip: new _restructure["default"].Reserved(_restructure["default"].uint8, 'actualSize')
});
var MCNK = (0, _chunk["default"])({
  flags: _restructure["default"].uint32le,
  indexX: _restructure["default"].uint32le,
  indexY: _restructure["default"].uint32le,
  layerCount: _restructure["default"].uint32le,
  doodadCount: _restructure["default"].uint32le,
  offsetMCVT: _restructure["default"].uint32le,
  offsetMCNR: _restructure["default"].uint32le,
  offsetMCLY: _restructure["default"].uint32le,
  offsetMCRF: _restructure["default"].uint32le,
  offsetMCAL: _restructure["default"].uint32le,
  sizeMCAL: _restructure["default"].uint32le,
  offsetMCSH: _restructure["default"].uint32le,
  sizeMCSH: _restructure["default"].uint32le,
  areaID: _restructure["default"].uint32le,
  wmoCount: _restructure["default"].uint32le,
  holes: _restructure["default"].uint16le,
  unknown: _restructure["default"].uint16le,
  textureMaps: new _restructure["default"].Reserved(_restructure["default"].uint16le, 8),
  predTex: _restructure["default"].uint32le,
  noEffectDoodad: _restructure["default"].uint32le,
  offsetMCSE: _restructure["default"].uint32le,
  soundEmitterCount: _restructure["default"].uint32le,
  offsetMCLQ: _restructure["default"].uint32le,
  sizeMCLQ: _restructure["default"].uint32le,
  position: _types.Vec3Float,
  offsetMCCV: _restructure["default"].uint32le,
  skip: new _restructure["default"].Reserved(_restructure["default"].uint32le, 2),
  MCVT: MCVT,
  MCCV: new _restructure["default"].Optional(_skipChunk["default"], function () {
    return this.offsetMCCV;
  }),
  MCNR: MCNR,
  MCLY: MCLY,
  MCRF: MCRF,
  MCSH: new _restructure["default"].Optional(MCSH, function () {
    return this.flags & 0x01;
  }),
  MCAL: _mcal["default"],
  MCLQ: new _restructure["default"].Optional(MCLQ, function () {
    return this.offsetMCLQ;
  }),
  MCSE: new _restructure["default"].Optional(_skipChunk["default"], function () {
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
    MDDF: new _restructure["default"].Optional(MDDF, function () {
      return this.MHDR.offsetMDDF;
    }),
    MODF: new _restructure["default"].Optional(_modf["default"], function () {
      return this.MHDR.offsetMODF;
    }),
    MH2O: new _restructure["default"].Optional(_mh2o["default"], function () {
      return this.MHDR.offsetMH2O;
    }),
    MCNKs: new _restructure["default"].Array(MCNK, 256),
    MFBO: new _restructure["default"].Optional(_skipChunk["default"], function () {
      return this.MHDR.offsetMFBO;
    }),
    MTXF: new _restructure["default"].Optional(_skipChunk["default"], function () {
      return this.MHDR.offsetMTXF;
    }),
    MTXP: new _restructure["default"].Optional(_skipChunk["default"], function () {
      return this.MHDR.offsetMTXP;
    })
  });
};
ADT.decode = function (stream) {
  return ADT().decode(stream);
};
var _default = ADT;
exports["default"] = _default;