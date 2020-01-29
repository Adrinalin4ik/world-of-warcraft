'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _chunk = require('../chunked/chunk');

var _chunk2 = _interopRequireDefault(_chunk);

var _chunked = require('../chunked');

var _chunked2 = _interopRequireDefault(_chunked);

var _mcal = require('./mcal');

var _mcal2 = _interopRequireDefault(_mcal);

var _modf = require('../chunked/modf');

var _modf2 = _interopRequireDefault(_modf);

var _mwmo = require('../chunked/mwmo');

var _mwmo2 = _interopRequireDefault(_mwmo);

var _mh2o = require('./mh2o');

var _mh2o2 = _interopRequireDefault(_mh2o);

var _skipChunk = require('../chunked/skip-chunk');

var _skipChunk2 = _interopRequireDefault(_skipChunk);

var _types = require('../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var MHDR = (0, _chunk2.default)({
  flags: _restructure2.default.uint32le,

  offsetMCIN: _restructure2.default.uint32le,
  offsetMTEX: _restructure2.default.uint32le,
  offsetMMDX: _restructure2.default.uint32le,
  offsetMMID: _restructure2.default.uint32le,
  offsetMWMO: _restructure2.default.uint32le,
  offsetMWID: _restructure2.default.uint32le,
  offsetMDDF: _restructure2.default.uint32le,
  offsetMODF: _restructure2.default.uint32le,
  offsetMFBO: _restructure2.default.uint32le,
  offsetMH2O: _restructure2.default.uint32le,
  offsetMTXF: _restructure2.default.uint32le,

  skip: new _restructure2.default.Reserved(_restructure2.default.uint32le, 4)
});

var MTEX = (0, _chunk2.default)({
  filenames: new _restructure2.default.Array(new _restructure2.default.String(null), 'size', 'bytes')
});

var MMDX = (0, _chunk2.default)({
  filenames: new _restructure2.default.Array(new _restructure2.default.String(null), 'size', 'bytes')
});

var MDDF = (0, _chunk2.default)({
  entries: new _restructure2.default.Array(new _restructure2.default.Struct({
    index: _restructure2.default.uint32le,
    id: _restructure2.default.uint32le,
    position: _types.Vec3Float,
    rotation: _types.Vec3Float,
    scale: _restructure2.default.uint16le,
    flags: _restructure2.default.uint16le,

    filename: function () {
      return this.parent.parent.MMDX.filenames[this.index];
    }
  }), 'size', 'bytes')
});

var MCVT = (0, _chunk2.default)({
  heights: new _restructure2.default.Array(_restructure2.default.floatle, 145)
});

var MCNR = (0, _chunk2.default)({
  normals: new _restructure2.default.Array(new _restructure2.default.Struct({
    x: _restructure2.default.int8,
    z: _restructure2.default.int8,
    y: _restructure2.default.int8
  }), 145),
  skip: new _restructure2.default.Reserved(_restructure2.default.uint8, 13)
});

var MCLY = (0, _chunk2.default)({
  layers: new _restructure2.default.Array(new _restructure2.default.Struct({
    textureID: _restructure2.default.uint32le,
    flags: _restructure2.default.uint32le,
    offsetMCAL: _restructure2.default.uint32le,
    effectID: _restructure2.default.int16le,
    skip: _restructure2.default.int16le,

    compressed: function () {
      return this.flags & 0x200;
    }
  }), 'size', 'bytes')
});

var MCRF = (0, _chunk2.default)({
  MDDFs: new _restructure2.default.Array(_restructure2.default.uint32le, function () {
    return this.parent.doodadCount;
  }),

  MODFs: new _restructure2.default.Array(_restructure2.default.uint32le, function () {
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
  skip: new _restructure2.default.Reserved(_restructure2.default.uint8, 'actualSize')
});

var MCLQ = (0, _chunk2.default)({
  // Incorrect size reported by MCLQ in some ADTs
  actualSize: function () {
    return this.parent.sizeMCLQ - 8;
  },
  skip: new _restructure2.default.Reserved(_restructure2.default.uint8, 'actualSize')
});

var MCNK = (0, _chunk2.default)({
  flags: _restructure2.default.uint32le,
  indexX: _restructure2.default.uint32le,
  indexY: _restructure2.default.uint32le,
  layerCount: _restructure2.default.uint32le,
  doodadCount: _restructure2.default.uint32le,
  offsetMCVT: _restructure2.default.uint32le,
  offsetMCNR: _restructure2.default.uint32le,
  offsetMCLY: _restructure2.default.uint32le,
  offsetMCRF: _restructure2.default.uint32le,
  offsetMCAL: _restructure2.default.uint32le,
  sizeMCAL: _restructure2.default.uint32le,
  offsetMCSH: _restructure2.default.uint32le,
  sizeMCSH: _restructure2.default.uint32le,
  areaID: _restructure2.default.uint32le,
  wmoCount: _restructure2.default.uint32le,
  holes: _restructure2.default.uint16le,
  unknown: _restructure2.default.uint16le,

  textureMaps: new _restructure2.default.Reserved(_restructure2.default.uint16le, 8),

  predTex: _restructure2.default.uint32le,
  noEffectDoodad: _restructure2.default.uint32le,
  offsetMCSE: _restructure2.default.uint32le,
  soundEmitterCount: _restructure2.default.uint32le,
  offsetMCLQ: _restructure2.default.uint32le,
  sizeMCLQ: _restructure2.default.uint32le,
  position: _types.Vec3Float,
  offsetMCCV: _restructure2.default.uint32le,

  skip: new _restructure2.default.Reserved(_restructure2.default.uint32le, 2),

  MCVT: MCVT,
  MCCV: new _restructure2.default.Optional(_skipChunk2.default, function () {
    return this.offsetMCCV;
  }),
  MCNR: MCNR,
  MCLY: MCLY,
  MCRF: MCRF,
  MCSH: new _restructure2.default.Optional(MCSH, function () {
    return this.flags & 0x01;
  }),
  MCAL: _mcal2.default,
  MCLQ: new _restructure2.default.Optional(MCLQ, function () {
    return this.offsetMCLQ;
  }),
  MCSE: new _restructure2.default.Optional(_skipChunk2.default, function () {
    return this.offsetMCSE;
  })
});

var ADT = function (wdtFlags) {
  return (0, _chunked2.default)({
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
    MDDF: new _restructure2.default.Optional(MDDF, function () {
      return this.MHDR.offsetMDDF;
    }),
    MODF: new _restructure2.default.Optional(_modf2.default, function () {
      return this.MHDR.offsetMODF;
    }),
    MH2O: new _restructure2.default.Optional(_mh2o2.default, function () {
      return this.MHDR.offsetMH2O;
    }),
    MCNKs: new _restructure2.default.Array(MCNK, 256),
    MFBO: new _restructure2.default.Optional(_skipChunk2.default, function () {
      return this.MHDR.offsetMFBO;
    }),
    MTXF: new _restructure2.default.Optional(_skipChunk2.default, function () {
      return this.MHDR.offsetMTXF;
    }),
    MTXP: new _restructure2.default.Optional(_skipChunk2.default, function () {
      return this.MHDR.offsetMTXP;
    })
  });
};

ADT.decode = function (stream) {
  return ADT().decode(stream);
};

exports.default = ADT;
module.exports = exports['default'];