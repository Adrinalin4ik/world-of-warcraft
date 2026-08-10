"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _chunk = _interopRequireDefault(require("../chunked/chunk"));
var _chunked = _interopRequireDefault(require("../chunked"));
var _skipChunk = _interopRequireDefault(require("../chunked/skip-chunk"));
var _paddedStrings = _interopRequireDefault(require("../chunked/padded-strings"));
var _types = require("../types");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var MOHD = (0, _chunk["default"])({
  textureCount: _restructure["default"].uint32le,
  groupCount: _restructure["default"].uint32le,
  portalCount: _restructure["default"].uint32le,
  lightCount: _restructure["default"].uint32le,
  modelCount: _restructure["default"].uint32le,
  doodadCount: _restructure["default"].uint32le,
  doodadSetCount: _restructure["default"].uint32le,
  ambientColor: new _restructure["default"].Struct({
    r: _restructure["default"].uint8,
    g: _restructure["default"].uint8,
    b: _restructure["default"].uint8,
    a: _restructure["default"].uint8
  }),
  wmoID: _restructure["default"].uint32le,
  minBoundingBox: _types.Vec3Float,
  maxBoundingBox: _types.Vec3Float,
  flags: _restructure["default"].uint32le,
  skipBaseColor: function skipBaseColor() {
    return (this.flags & 0x02) !== 0;
  }
});
var MOTX = (0, _chunk["default"])({
  filenames: new _paddedStrings["default"]('size', 'bytes')
});
var MOMT = (0, _chunk["default"])({
  materials: new _restructure["default"].Array(new _restructure["default"].Struct({
    flags: _restructure["default"].uint32le,
    shader: _restructure["default"].uint32le,
    blendMode: _restructure["default"].uint32le,
    textures: new _restructure["default"].Array(new _restructure["default"].Struct({
      offset: _restructure["default"].uint32le,
      color: new _restructure["default"].Struct({
        r: _restructure["default"].uint8,
        g: _restructure["default"].uint8,
        b: _restructure["default"].uint8,
        a: _restructure["default"].uint8
      }),
      flags: _restructure["default"].uint32le
    }), 3),
    unknowns: new _restructure["default"].Reserved(_restructure["default"].uint32le, 4)
  }), 'size', 'bytes')
});
var MOGN = (0, _chunk["default"])({
  names: new _restructure["default"].Array(new _restructure["default"].String(null), 'size', 'bytes')
});
var MOGI = (0, _chunk["default"])({
  groups: new _restructure["default"].Array(new _restructure["default"].Struct({
    flags: _restructure["default"].uint32le,
    minBoundingBox: _types.Vec3Float,
    maxBoundingBox: _types.Vec3Float,
    nameOffset: _restructure["default"].int32le,
    indoor: function indoor() {
      return (this.flags & 0x2000) !== 0 && (this.flags & 0x8) === 0;
    }
  }), 'size', 'bytes')
});
var MOSB = (0, _chunk["default"])({
  skybox: new _restructure["default"].String('size')
});
var MODS = (0, _chunk["default"])({
  sets: new _restructure["default"].Array(new _restructure["default"].Struct({
    name: new _restructure["default"].String(20),
    startIndex: _restructure["default"].uint32le,
    doodadCount: _restructure["default"].uint32le,
    unused: new _restructure["default"].Reserved(_restructure["default"].uint32le)
  }), 'size', 'bytes')
});
var MODN = (0, _chunk["default"])({
  filenames: new _paddedStrings["default"]('size', 'bytes')
});
var MODD = (0, _chunk["default"])({
  doodads: new _restructure["default"].Array(new _restructure["default"].Struct({
    filenameOffset: _restructure["default"].uint24le,
    filename: function filename() {
      return this.parent.parent.MODN.filenames[this.filenameOffset];
    },
    flags: _restructure["default"].uint8,
    position: _types.Vec3Float,
    rotation: _types.Quat,
    scale: _restructure["default"].floatle,
    color: _restructure["default"].uint32le
  }), 'size', 'bytes')
});
var MFOG = (0, _chunk["default"])({
  fogs: new _restructure["default"].Array(new _restructure["default"].Struct({
    flags: _restructure["default"].uint32le,
    position: _types.Vec3Float,
    smallerRadius: _restructure["default"].floatle,
    largerRadius: _restructure["default"].floatle,
    fogEnd: _restructure["default"].floatle,
    fogStartMultiplier: _restructure["default"].floatle,
    color: _restructure["default"].uint32le,
    unknowns: new _restructure["default"].Reserved(_restructure["default"].floatle, 2),
    color2: _restructure["default"].uint32le
  }), 'size', 'bytes')
});
var MOPV = (0, _chunk["default"])({
  vertices: new _restructure["default"].Array(_types.float32array3, 'size', 'bytes')
});
var MOPT = (0, _chunk["default"])({
  portals: new _restructure["default"].Array(new _restructure["default"].Struct({
    vertexOffset: _restructure["default"].uint16le,
    vertexCount: _restructure["default"].uint16le,
    plane: new _restructure["default"].Struct({
      normal: _types.float32array3,
      constant: _restructure["default"].floatle
    })
  }), 'size', 'bytes')
});
var MOPR = (0, _chunk["default"])({
  references: new _restructure["default"].Array(new _restructure["default"].Struct({
    portalIndex: _restructure["default"].uint16le,
    groupIndex: _restructure["default"].uint16le,
    side: _restructure["default"].int16le,
    unknown1: _restructure["default"].uint16le
  }), 'size', 'bytes')
});
var _default = (0, _chunked["default"])({
  MOHD: MOHD,
  MOTX: MOTX,
  MOMT: MOMT,
  MOGN: MOGN,
  MOGI: MOGI,
  MOSB: MOSB,
  MOPV: MOPV,
  MOPT: MOPT,
  MOPR: MOPR,
  MOVV: _skipChunk["default"],
  MOVB: _skipChunk["default"],
  MOLT: _skipChunk["default"],
  MODS: MODS,
  MODN: MODN,
  MODD: MODD,
  MFOG: MFOG,
  // TODO: Optional MCVP chunk

  flags: function flags() {
    return this.MOHD.flags;
  }
});
exports["default"] = _default;