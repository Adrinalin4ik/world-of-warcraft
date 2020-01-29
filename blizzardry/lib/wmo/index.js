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

var _skipChunk = require('../chunked/skip-chunk');

var _skipChunk2 = _interopRequireDefault(_skipChunk);

var _paddedStrings = require('../chunked/padded-strings');

var _paddedStrings2 = _interopRequireDefault(_paddedStrings);

var _types = require('../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var MOHD = (0, _chunk2.default)({
  textureCount: _restructure2.default.uint32le,
  groupCount: _restructure2.default.uint32le,
  portalCount: _restructure2.default.uint32le,
  lightCount: _restructure2.default.uint32le,
  modelCount: _restructure2.default.uint32le,
  doodadCount: _restructure2.default.uint32le,
  doodadSetCount: _restructure2.default.uint32le,
  ambientColor: new _restructure2.default.Struct({
    r: _restructure2.default.uint8,
    g: _restructure2.default.uint8,
    b: _restructure2.default.uint8,
    a: _restructure2.default.uint8
  }),
  wmoID: _restructure2.default.uint32le,
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  flags: _restructure2.default.uint32le,

  skipBaseColor: function () {
    return (this.flags & 0x02) !== 0;
  }
});

var MOTX = (0, _chunk2.default)({
  filenames: new _paddedStrings2.default('size', 'bytes')
});

var MOMT = (0, _chunk2.default)({
  materials: new _restructure2.default.Array(new _restructure2.default.Struct({
    flags: _restructure2.default.uint32le,
    shader: _restructure2.default.uint32le,
    blendMode: _restructure2.default.uint32le,

    textures: new _restructure2.default.Array(new _restructure2.default.Struct({
      offset: _restructure2.default.uint32le,
      color: new _restructure2.default.Struct({
        r: _restructure2.default.uint8,
        g: _restructure2.default.uint8,
        b: _restructure2.default.uint8,
        a: _restructure2.default.uint8
      }),
      flags: _restructure2.default.uint32le
    }), 3),

    unknowns: new _restructure2.default.Reserved(_restructure2.default.uint32le, 4)
  }), 'size', 'bytes')
});

var MOGN = (0, _chunk2.default)({
  names: new _restructure2.default.Array(new _restructure2.default.String(null), 'size', 'bytes')
});

var MOGI = (0, _chunk2.default)({
  groups: new _restructure2.default.Array(new _restructure2.default.Struct({
    flags: _restructure2.default.uint32le,
    minBoundingBox: _types.Vec3Float,
    maxBoundingBox: _types.Vec3Float,
    nameOffset: _restructure2.default.int32le,

    indoor: function () {
      return (this.flags & 0x2000) !== 0 && (this.flags & 0x8) === 0;
    }
  }), 'size', 'bytes')
});

var MOSB = (0, _chunk2.default)({
  skybox: new _restructure2.default.String('size')
});

var MODS = (0, _chunk2.default)({
  sets: new _restructure2.default.Array(new _restructure2.default.Struct({
    name: new _restructure2.default.String(20),
    startIndex: _restructure2.default.uint32le,
    doodadCount: _restructure2.default.uint32le,
    unused: new _restructure2.default.Reserved(_restructure2.default.uint32le)
  }), 'size', 'bytes')
});

var MODN = (0, _chunk2.default)({
  filenames: new _paddedStrings2.default('size', 'bytes')
});

var MODD = (0, _chunk2.default)({
  doodads: new _restructure2.default.Array(new _restructure2.default.Struct({
    filenameOffset: _restructure2.default.uint24le,
    filename: function () {
      return this.parent.parent.MODN.filenames[this.filenameOffset];
    },
    flags: _restructure2.default.uint8,
    position: _types.Vec3Float,
    rotation: _types.Quat,
    scale: _restructure2.default.floatle,
    color: _restructure2.default.uint32le
  }), 'size', 'bytes')
});

var MFOG = (0, _chunk2.default)({
  fogs: new _restructure2.default.Array(new _restructure2.default.Struct({
    flags: _restructure2.default.uint32le,
    position: _types.Vec3Float,
    smallerRadius: _restructure2.default.floatle,
    largerRadius: _restructure2.default.floatle,
    fogEnd: _restructure2.default.floatle,
    fogStartMultiplier: _restructure2.default.floatle,
    color: _restructure2.default.uint32le,
    unknowns: new _restructure2.default.Reserved(_restructure2.default.floatle, 2),
    color2: _restructure2.default.uint32le
  }), 'size', 'bytes')
});

var MOPV = (0, _chunk2.default)({
  vertices: new _restructure2.default.Array(_types.float32array3, 'size', 'bytes')
});

var MOPT = (0, _chunk2.default)({
  portals: new _restructure2.default.Array(new _restructure2.default.Struct({
    vertexOffset: _restructure2.default.uint16le,
    vertexCount: _restructure2.default.uint16le,
    plane: new _restructure2.default.Struct({
      normal: _types.float32array3,
      constant: _restructure2.default.floatle
    })
  }), 'size', 'bytes')
});

var MOPR = (0, _chunk2.default)({
  references: new _restructure2.default.Array(new _restructure2.default.Struct({
    portalIndex: _restructure2.default.uint16le,
    groupIndex: _restructure2.default.uint16le,
    side: _restructure2.default.int16le,
    unknown1: _restructure2.default.uint16le
  }), 'size', 'bytes')
});

exports.default = (0, _chunked2.default)({
  MOHD: MOHD,
  MOTX: MOTX,
  MOMT: MOMT,
  MOGN: MOGN,
  MOGI: MOGI,
  MOSB: MOSB,
  MOPV: MOPV,
  MOPT: MOPT,
  MOPR: MOPR,
  MOVV: _skipChunk2.default,
  MOVB: _skipChunk2.default,
  MOLT: _skipChunk2.default,
  MODS: MODS,
  MODN: MODN,
  MODD: MODD,
  MFOG: MFOG,
  // TODO: Optional MCVP chunk

  flags: function () {
    return this.MOHD.flags;
  }
});
module.exports = exports['default'];