import * as r from 'restructure';

import Chunked from '../chunked';
import Chunk from '../chunked/chunk';
import PaddedStrings from '../chunked/padded-strings';
import SkipChunk from '../chunked/skip-chunk';
import { float32array3, Quat, Vec3Float } from '../types';

const MOHD = Chunk({
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
  minBoundingBox: Vec3Float,
  maxBoundingBox: Vec3Float,
  flags: r.uint32le,

  skipBaseColor: function() {
    return (this.flags & 0x02) !== 0;
  }
});

const MOTX = Chunk({
  filenames: new PaddedStrings('size', 'bytes')
});

const MOMT = Chunk({
  materials: new r.Array(new r.Struct({
    flags: r.uint32le,
    shader: r.uint32le,
    blendMode: r.uint32le,
    // textures: [
    //   new r.Struct({
    //     offset: r.int32le,
    //     color: new r.Struct({
    //       r: r.uint8,
    //       g: r.uint8,
    //       b: r.uint8,
    //       a: r.uint8
    //     }),
    //     flags: r.int32le
    //   }),
    //   new r.Struct({
    //     offset: r.int32le,
    //     color2: new r.Struct({
    //       r: r.uint8,
    //       g: r.uint8,
    //       b: r.uint8,
    //       a: r.uint8
    //     }),
    //     flags: r.int32le,
    //     color3: new r.Struct({
    //       r: r.uint8,
    //       g: r.uint8,
    //       b: r.uint8,
    //       a: r.uint8
    //     }),
    //   })
    // ],

    texture1: new r.Struct({
      offset: r.int32le,
      color: new r.Struct({
        r: r.uint8,
        g: r.uint8,
        b: r.uint8,
        a: r.uint8
      }),
      flags: r.int32le
    }),
    texture2: new r.Struct({
      offset: r.int32le,
      color2: new r.Struct({
        r: r.uint8,
        g: r.uint8,
        b: r.uint8,
        a: r.uint8
      }),
      flags: r.int32le,
      color3: new r.Struct({
        r: r.uint8,
        g: r.uint8,
        b: r.uint8,
        a: r.uint8
      }),
    }),
    unknown1: r.int32le,
    dx: new r.Array(r.int32le, 5),
    // textures: new r.Array(new r.Struct({
    //   offset: r.uint32le,
    //   color: new r.Struct({
    //     r: r.uint8,
    //     g: r.uint8,
    //     b: r.uint8,
    //     a: r.uint8
    //   }),
    //   flags: r.uint32le
    // }), 3),

    // unknowns: new r.Reserved(r.uint32le, 4)
  }), 'size', 'bytes')
});

const MOGN = Chunk({
  names: new r.Array(new r.String(null), 'size', 'bytes')
});

const MOGI = Chunk({
  groups: new r.Array(new r.Struct({
    flags: r.uint32le,
    minBoundingBox: Vec3Float,
    maxBoundingBox: Vec3Float,
    nameOffset: r.int32le,

    interior: function() {
      return (this.flags & 0x2000) !== 0 && (this.flags & 0x8) === 0;
    }
  }), 'size', 'bytes')
});

const MOSB = Chunk({
  skybox: new r.String('size')
});

const MODS = Chunk({
  sets: new r.Array(new r.Struct({
    name: new r.String(20),
    startIndex: r.uint32le,
    doodadCount: r.uint32le,
    unused: new r.Reserved(r.uint32le)
  }), 'size', 'bytes')
});

const MODN = Chunk({
  filenames: new PaddedStrings('size', 'bytes')
});

const MODD = Chunk({
  doodads: new r.Array(new r.Struct({
    filenameOffset: r.uint24le,
    filename: function() {
      return this.parent.parent.MODN.filenames[this.filenameOffset];
    },
    flags: r.uint8,
    position: Vec3Float,
    rotation: Quat,
    scale: r.floatle,
    color: r.uint32le
  }), 'size', 'bytes')
});

const MOLT = Chunk({
  lights: new r.Array(new r.Struct({
    type: r.uint8,                    // LightType enum (0=OMNI, 1=SPOT, 2=DIRECT, 3=AMBIENT)
    useAtten: r.uint8,                // Use attenuation flag
    pad: new r.Reserved(r.uint8, 2),  // Padding (2 bytes)
    color: r.uint32le,                // CImVector color (BGRA)
    position: Vec3Float,              // C3Vector position (XYZ)
    intensity: r.floatle,             // Light intensity
    rotation: new r.Struct({          // C4Quaternion rotation (for spot/direct lights)
      x: r.floatle,
      y: r.floatle,
      z: r.floatle,
      w: r.floatle
    }),
    attenStart: r.floatle,            // Attenuation start distance
    attenEnd: r.floatle               // Attenuation end distance
  }), 'size', 'bytes')
});

const MFOG = Chunk({
  fogs: new r.Array(new r.Struct({
    flag_infinite_radius: r.uint32le,  // Flag: infinite radius (bit 0)
    pos: Vec3Float,                    // C3Vector position
    smaller_radius: r.floatle,         // Start radius
    larger_radius: r.floatle,          // End radius
    fogs: new r.Array(new r.Struct({   // Array of 2 fog types (FOG and UWFOG)
      end: r.floatle,                  // Fog end distance
      start_scalar: r.floatle,         // Start scalar (0..1)
      color: r.uint32le                // CImVector color (BGRA)
    }), 2)                             // NUM_FOGS = 2 (FOG and UWFOG)
  }), 'size', 'bytes')
});

const MOPV = Chunk({
  vertices: new r.Array(float32array3, 'size', 'bytes')
});

const MOPT = Chunk({
  portals: new r.Array(new r.Struct({
    vertexOffset: r.uint16le,
    vertexCount: r.uint16le,
    plane: new r.Struct({
      normal: float32array3,
      constant: r.floatle
    })
  }), 'size', 'bytes')
});

const MOPR = Chunk({
  references: new r.Array(new r.Struct({
    portalIndex: r.uint16le,
    groupIndex: r.uint16le,
    side: r.int16le,
    unknown1: r.uint16le
  }), 'size', 'bytes')
});

export default Chunked({
  MOHD: MOHD,
  MOTX: MOTX,
  MOMT: MOMT,
  MOGN: MOGN,
  MOGI: MOGI,
  MOSB: MOSB,
  MOPV: MOPV,
  MOPT: MOPT,
  MOPR: MOPR,
  MOVV: SkipChunk,
  MOVB: SkipChunk,
  MOLT: MOLT,
  MODS: MODS,
  MODN: MODN,
  MODD: MODD,
  MFOG: MFOG,
  // TODO: Optional MCVP chunk

  flags: function() {
    return this.MOHD.flags;
  }
});
