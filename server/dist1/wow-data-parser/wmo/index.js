'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _chunked = require('../chunked');

var _chunked2 = _interopRequireDefault(_chunked);

var _chunk = require('../chunked/chunk');

var _chunk2 = _interopRequireDefault(_chunk);

var _paddedStrings = require('../chunked/padded-strings');

var _paddedStrings2 = _interopRequireDefault(_paddedStrings);

var _skipChunk = require('../chunked/skip-chunk');

var _skipChunk2 = _interopRequireDefault(_skipChunk);

var _types = require('../types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

var MOHD = (0, _chunk2.default)({
  textureCount: r.uint32le,
  groupCount: r.uint32le,
  portalCount: r.uint32le,
  lightCount: r.uint32le,
  modelCount: r.uint32le,
  doodadCount: r.uint32le,
  doodadSetCount: r.uint32le,
  ambientColor: new r.Struct({
    r: r.uint8,
    g: r.uint8,
    b: r.uint8,
    a: r.uint8
  }),
  wmoID: r.uint32le,
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  flags: r.uint32le,

  skipBaseColor: function () {
    return (this.flags & 0x02) !== 0;
  }
});

var MOTX = (0, _chunk2.default)({
  filenames: new _paddedStrings2.default('size', 'bytes')
});

var MOMT = (0, _chunk2.default)({
  materials: new r.Array(new r.Struct({
    flags: r.uint32le,
    shader: r.uint32le,
    blendMode: r.uint32le,

    textures: new r.Array(new r.Struct({
      offset: r.uint32le,
      color: new r.Struct({
        r: r.uint8,
        g: r.uint8,
        b: r.uint8,
        a: r.uint8
      }),
      flags: r.uint32le
    }), 3),

    unknowns: new r.Reserved(r.uint32le, 4)
  }), 'size', 'bytes')
});

var MOGN = (0, _chunk2.default)({
  names: new r.Array(new r.String(null), 'size', 'bytes')
});

var MOGI = (0, _chunk2.default)({
  groups: new r.Array(new r.Struct({
    flags: r.uint32le,
    minBoundingBox: _types.Vec3Float,
    maxBoundingBox: _types.Vec3Float,
    nameOffset: r.int32le,

    indoor: function () {
      return (this.flags & 0x2000) !== 0 && (this.flags & 0x8) === 0;
    }
  }), 'size', 'bytes')
});

var MOSB = (0, _chunk2.default)({
  skybox: new r.String('size')
});

var MODS = (0, _chunk2.default)({
  sets: new r.Array(new r.Struct({
    name: new r.String(20),
    startIndex: r.uint32le,
    doodadCount: r.uint32le,
    unused: new r.Reserved(r.uint32le)
  }), 'size', 'bytes')
});

var MODN = (0, _chunk2.default)({
  filenames: new _paddedStrings2.default('size', 'bytes')
});

var MODD = (0, _chunk2.default)({
  doodads: new r.Array(new r.Struct({
    filenameOffset: r.uint24le,
    filename: function () {
      return this.parent.parent.MODN.filenames[this.filenameOffset];
    },
    flags: r.uint8,
    position: _types.Vec3Float,
    rotation: _types.Quat,
    scale: r.floatle,
    color: r.uint32le
  }), 'size', 'bytes')
});

var MFOG = (0, _chunk2.default)({
  fogs: new r.Array(new r.Struct({
    flags: r.uint32le,
    position: _types.Vec3Float,
    smallerRadius: r.floatle,
    largerRadius: r.floatle,
    fogEnd: r.floatle,
    fogStartMultiplier: r.floatle,
    color: r.uint32le,
    unknowns: new r.Reserved(r.floatle, 2),
    color2: r.uint32le
  }), 'size', 'bytes')
});

var MOPV = (0, _chunk2.default)({
  vertices: new r.Array(_types.float32array3, 'size', 'bytes')
});

var MOPT = (0, _chunk2.default)({
  portals: new r.Array(new r.Struct({
    vertexOffset: r.uint16le,
    vertexCount: r.uint16le,
    plane: new r.Struct({
      normal: _types.float32array3,
      constant: r.floatle
    })
  }), 'size', 'bytes')
});

var MOPR = (0, _chunk2.default)({
  references: new r.Array(new r.Struct({
    portalIndex: r.uint16le,
    groupIndex: r.uint16le,
    side: r.int16le,
    unknown1: r.uint16le
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