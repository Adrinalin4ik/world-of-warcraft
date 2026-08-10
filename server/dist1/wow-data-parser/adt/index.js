'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ADT = undefined;

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _chunked = require('../chunked');

var _chunked2 = _interopRequireDefault(_chunked);

var _chunk = require('../chunked/chunk');

var _chunk2 = _interopRequireDefault(_chunk);

var _mwmo = require('../chunked/mwmo');

var _mwmo2 = _interopRequireDefault(_mwmo);

var _skipChunk = require('../chunked/skip-chunk');

var _skipChunk2 = _interopRequireDefault(_skipChunk);

var _types = require('../types');

var _mcal = require('./mcal');

var _mcal2 = _interopRequireDefault(_mcal);

var _modf = require('../chunked/modf');

var _modf2 = _interopRequireDefault(_modf);

var _mh2o = require('./mh2o');

var _mh2o2 = _interopRequireDefault(_mh2o);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

var MHDR = (0, _chunk2.default)({
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

var MTEX = (0, _chunk2.default)({
  filenames: new r.Array(new r.String(null), 'size', 'bytes')
});

var MMDX = (0, _chunk2.default)({
  filenames: new r.Array(new r.String(null), 'size', 'bytes')
});

var MDDF = (0, _chunk2.default)({
  entries: new r.Array(new r.Struct({
    index: r.uint32le,
    id: r.uint32le,
    position: _types.Vec3Float,
    rotation: _types.Vec3Float,
    scale: r.uint16le,
    flags: r.uint16le,

    filename: function () {
      return this.parent.parent.MMDX.filenames[this.index];
    }
  }), 'size', 'bytes')
});

var MCVT = (0, _chunk2.default)({
  heights: new r.Array(r.floatle, 145)
});

var MCNR = (0, _chunk2.default)({
  normals: new r.Array(new r.Struct({
    x: r.int8,
    z: r.int8,
    y: r.int8
  }), 145),
  skip: new r.Reserved(r.uint8, 13)
});

var MCLY = (0, _chunk2.default)({
  layers: new r.Array(new r.Struct({
    textureID: r.uint32le,
    flags: r.uint32le,
    offsetMCAL: r.uint32le,
    effectID: r.int16le,
    skip: r.int16le,

    compressed: function () {
      return this.flags & 0x200;
    }
  }), 'size', 'bytes')
});

var MCRF = (0, _chunk2.default)({
  MDDFs: new r.Array(r.uint32le, function () {
    return this.parent.doodadCount;
  }),

  MODFs: new r.Array(r.uint32le, function () {
    return this.parent.wmoCount;
  }),

  doodadEntries: function () {
    var entries = this.parent.parent.MDDF.entries;
    return this.MDDFs.map(id => entries[id]);
  },

  wmoEntries: function () {
    var entries = this.parent.parent.MODF.entries;
    return this.MODFs.map(id => entries[id]);
  }
});

var MCSH = (0, _chunk2.default)({
  // Incorrect size reported by MCSH in some ADTs
  actualSize: function () {
    return this.parent.sizeMCSH;
  },
  skip: new r.Reserved(r.uint8, 'actualSize')
});

var MCLQ = (0, _chunk2.default)({
  // Incorrect size reported by MCLQ in some ADTs
  actualSize: function () {
    return this.parent.sizeMCLQ - 8;
  },
  skip: new r.Reserved(r.uint8, 'actualSize')
});

var MCNK = (0, _chunk2.default)({
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
  MCCV: new r.Optional(_skipChunk2.default, function () {
    return this.offsetMCCV;
  }),
  MCNR: MCNR,
  MCLY: MCLY,
  MCRF: MCRF,
  MCSH: new r.Optional(MCSH, function () {
    return this.flags & 0x01;
  }),
  MCAL: _mcal2.default,
  MCLQ: new r.Optional(MCLQ, function () {
    return this.offsetMCLQ;
  }),
  MCSE: new r.Optional(_skipChunk2.default, function () {
    return this.offsetMCSE;
  })
});

// const ADT = function(wdtFlags) {
//   return Chunked({
//     MHDR: MHDR,

//     flags: function() {
//       return this.MHDR.flags;
//     },

//     wdtFlags: function() {
//       return wdtFlags;
//     },

//     MCIN: SkipChunk,
//     MTEX: MTEX,
//     MMDX: MMDX,
//     MMID: SkipChunk,
//     MWMO: MWMO,
//     MWID: SkipChunk,
//     MDDF: new r.Optional(MDDF, function() {
//       return this.MHDR.offsetMDDF;
//     }),
//     MODF: new r.Optional(MODF, function() {
//       return this.MHDR.offsetMODF;
//     }),
//     MH2O: new r.Optional(MH2O, function() {
//       return this.MHDR.offsetMH2O;
//     }),
//     MCNKs: new r.Array(MCNK, 256),
//     MFBO: new r.Optional(SkipChunk, function() {
//       return this.MHDR.offsetMFBO;
//     }),
//     MTXF: new r.Optional(SkipChunk, function() {
//       return this.MHDR.offsetMTXF;
//     }),
//     MTXP: new r.Optional(SkipChunk, function() {
//       return this.MHDR.offsetMTXP;
//     })
//   });
// };

class ADT extends _chunked2.default {
  constructor(wdtFlags) {
    super({
      MHDR: MHDR,

      flags: function () {
        return this.MHDR.flags;
      },

      wdtFlags: function () {
        return wdtFlags;
      },

      MCIN: _skipChunk2.default,
      MTEX: MTEX,
      MMDX: MMDX,
      MMID: _skipChunk2.default,
      MWMO: _mwmo2.default,
      MWID: _skipChunk2.default,
      MDDF: new r.Optional(MDDF, function () {
        return this.MHDR.offsetMDDF;
      }),
      MODF: new r.Optional(_modf2.default, function () {
        return this.MHDR.offsetMODF;
      }),
      MH2O: new r.Optional(_mh2o2.default, function () {
        return this.MHDR.offsetMH2O;
      }),
      MCNKs: new r.Array(MCNK, 256),
      MFBO: new r.Optional(_skipChunk2.default, function () {
        return this.MHDR.offsetMFBO;
      }),
      MTXF: new r.Optional(_skipChunk2.default, function () {
        return this.MHDR.offsetMTXF;
      }),
      MTXP: new r.Optional(_skipChunk2.default, function () {
        return this.MHDR.offsetMTXP;
      })
    });
  }

  // static decode(stream) {
  //   debugger
  //   console.log('here')
  // }
}

exports.ADT = ADT; // ADT.decode = function(stream) {
//   console.log('here')
//   return new ADT().decode(stream);
// };

exports.default = ADT;