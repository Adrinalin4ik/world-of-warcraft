"use strict";

function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var r = _interopRequireWildcard(require("restructure"));
var _chunked = _interopRequireDefault(require("../chunked"));
var _chunk = _interopRequireDefault(require("../chunked/chunk"));
var _paddedStrings = _interopRequireDefault(require("../chunked/padded-strings"));
var _skipChunk = _interopRequireDefault(require("../chunked/skip-chunk"));
var _types = require("../types");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function _getRequireWildcardCache(nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || _typeof(obj) !== "object" && typeof obj !== "function") { return { "default": obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj["default"] = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
var MOHD = (0, _chunk["default"])({
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
  skipBaseColor: function skipBaseColor() {
    return (this.flags & 0x02) !== 0;
  }
});
var MOTX = (0, _chunk["default"])({
  filenames: new _paddedStrings["default"]('size', 'bytes')
});
var MOMT = (0, _chunk["default"])({
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
var MOGN = (0, _chunk["default"])({
  names: new r.Array(new r.String(null), 'size', 'bytes')
});
var MOGI = (0, _chunk["default"])({
  groups: new r.Array(new r.Struct({
    flags: r.uint32le,
    minBoundingBox: _types.Vec3Float,
    maxBoundingBox: _types.Vec3Float,
    nameOffset: r.int32le,
    indoor: function indoor() {
      return (this.flags & 0x2000) !== 0 && (this.flags & 0x8) === 0;
    }
  }), 'size', 'bytes')
});
var MOSB = (0, _chunk["default"])({
  skybox: new r.String('size')
});
var MODS = (0, _chunk["default"])({
  sets: new r.Array(new r.Struct({
    name: new r.String(20),
    startIndex: r.uint32le,
    doodadCount: r.uint32le,
    unused: new r.Reserved(r.uint32le)
  }), 'size', 'bytes')
});
var MODN = (0, _chunk["default"])({
  filenames: new _paddedStrings["default"]('size', 'bytes')
});
var MODD = (0, _chunk["default"])({
  doodads: new r.Array(new r.Struct({
    filenameOffset: r.uint24le,
    filename: function filename() {
      return this.parent.parent.MODN.filenames[this.filenameOffset];
    },
    flags: r.uint8,
    position: _types.Vec3Float,
    rotation: _types.Quat,
    scale: r.floatle,
    color: r.uint32le
  }), 'size', 'bytes')
});
var MFOG = (0, _chunk["default"])({
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
var MOPV = (0, _chunk["default"])({
  vertices: new r.Array(_types.float32array3, 'size', 'bytes')
});
var MOPT = (0, _chunk["default"])({
  portals: new r.Array(new r.Struct({
    vertexOffset: r.uint16le,
    vertexCount: r.uint16le,
    plane: new r.Struct({
      normal: _types.float32array3,
      constant: r.floatle
    })
  }), 'size', 'bytes')
});
var MOPR = (0, _chunk["default"])({
  references: new r.Array(new r.Struct({
    portalIndex: r.uint16le,
    groupIndex: r.uint16le,
    side: r.int16le,
    unknown1: r.uint16le
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
//# sourceMappingURL=index.js.map