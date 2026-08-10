'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _chunk = require('../chunked/chunk');

var _chunk2 = _interopRequireDefault(_chunk);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class MCAL {

  constructor() {
    this.chunk = (0, _chunk2.default)();
  }

  decode(stream, parent) {
    var data = this.chunk.decode(stream, parent);

    // Skip the fully opaque initial layer
    var layers = parent.MCLY.layers.slice(1);
    data.alphaMaps = layers.map(layer => {
      if (layer.compressed) {
        return this.decodeCompressed(stream);
      }
      return this.decodeUncompressed(stream, parent);
    });

    return data;
  }

  decodeCompressed(stream) {
    var size = this.constructor.ALPHA_MAP_SIZE;
    var buffer = stream.buffer;
    var alpha = new Buffer(size);

    var writePos = 0;
    while (writePos < size) {
      var fill = buffer[stream.pos] & 0x80;
      var count = buffer[stream.pos] & 0x7F;
      stream.pos++;
      for (var i = 0; i < count; ++i) {
        if (writePos === size) {
          break;
        }
        alpha[writePos] = buffer[stream.pos];
        writePos++;
        if (!fill) {
          stream.pos++;
        }
      }
      if (fill) {
        stream.pos++;
      }
    }

    return alpha;
  }

  decodeUncompressed(stream, parent) {
    var size = this.constructor.ALPHA_MAP_SIZE;
    var wdtFlags = parent.parent.wdtFlags;
    if (wdtFlags & 0x4 || wdtFlags & 0x80) {
      return stream.readBuffer(size);
    }

    var halfSize = this.constructor.ALPHA_MAP_HALF_SIZE;
    var buffer = stream.readBuffer(halfSize);
    var alpha = new Buffer(size);
    var side = Math.sqrt(size);

    for (var i = 0; i < halfSize; ++i) {
      var value = buffer[i];
      var offset = i * 2;
      alpha[offset] = (value & 0x0F) * 17;
      alpha[offset + 1] = (value >> 4) * 17;

      // Correct broken alpha maps unless flagged as correct by chunk
      // See: http://www.pxr.dk/wowdev/wiki/index.php?title=ADT/v18#Uncompressed_.282048.29
      if (!(parent.flags & 0x200)) {
        if (offset > size - side) {
          alpha[offset] = alpha[offset - side];
          alpha[offset + 1] = alpha[offset + 1 - side];
        }
        if (offset % side === side - 2) {
          alpha[offset + 1] = alpha[offset];
        }
      }
    }

    return alpha;
  }

}

MCAL.ALPHA_MAP_SIZE = 4096;
MCAL.ALPHA_MAP_HALF_SIZE = 2048;
exports.default = new MCAL();
module.exports = exports['default'];