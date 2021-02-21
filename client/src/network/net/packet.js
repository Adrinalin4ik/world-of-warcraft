import ByteBuffer from 'byte-buffer';
import GUID from '../game/guid';

class Packet extends ByteBuffer {
  
  // Creates a new packet with given opcode from given source or length
  constructor(opcode, source, outgoing = true) {
    super(source, ByteBuffer.LITTLE_ENDIAN);

    // Holds the opcode for this packet
    this.opcode = opcode;

    // Whether this packet is outgoing or incoming
    this.outgoing = outgoing;

    // Seek past opcode to reserve space for it when finalizing
    this.index = this.headerSize;
    // this.headerSize = headerSize;
  }

  // // Header size in bytes
  get headerSize() {
    return this.constructor.HEADER_SIZE || 0;
  }

  // Body size in bytes
  get bodySize() {
    return this.length - this.headerSize;
  }

  // Retrieves the name of the opcode for this packet (if available)
  get opcodeName() {
    return null;
  }

  // Short string representation of this packet
  toString() {
    const opcode = ('0000' + this.opcode.toString(16).toUpperCase()).slice(-4);
    return `[${this.constructor.name}; Opcode: ${this.opcodeName || 'UNKNOWN'} (0x${opcode}); Length: ${this.length}; Body: ${this.bodySize}; Index: ${this.index}]`;
  }

  // Finalizes this packet
  finalize() {
    return this;
  }

  // Reads GUID from this packet
  readGUID() {
    return new GUID(this.read(GUID.LENGTH));
  }

  // Writes given GUID to this packet
  writeGUID(guid) {
    this.write(guid.raw);
    return this;
  }

  // // Reads packed GUID from this packet
  // // TODO: Implementation
  // readPackedGUID: ->
  //   return null

  readPackedGUID() {
      var guidMark = this.readUnsignedByte();

      var guid = 0;

      var i;
      for (i = 0; i < 8; ++i)
      {
          if(guidMark & (1 << i))
          {
              if(this.index + 1 > this.length) 
                  throw "Buffer exception "+this.index+" >= "+this.lenght;

              var bit = this.readUnsignedByte();
              guid |= (bit << (i * 8));
          }
      }

      return guid;
  }

  // readPackedGUID() {
  //   const mask = this.readByte();

  //   if (mask === 0)
  //   {
  //       return 0;
  //   }

  //   let res = 0;

  //   let i = 0;
  //   while (i < 8)
  //   {
  //       if ((mask & 1 << i) !== 0)
  //       {
  //           res += this.readByte() << (i * 8);
  //       }
  //       i++;
  //   }

  //   return res;
  // }

  readVector3() {
    return {
      x: this.readFloat(),
      y: this.readFloat(),
      z: this.readFloat()
    };
  }

  readVector4() {
    return {
      x: this.readFloat(),
      y: this.readFloat(),
      z: this.readFloat(),
      o: this.readFloat()
    };
  }

  readPackedQuaternion() {
    const packed = this.readByte(8);
    let x = (packed >> 42) * (1.0 / 2097152.0);
    let y = (((packed << 22) >> 32) >> 11) * (1.0 / 1048576.0);
    let z = (packed << 43 >> 43) * (1.0 / 1048576.0);

    let w = x * x + y * y + z * z;
    if (Math.abs(w - 1.0) >= (1 / 1048576.0)) {
        w = Math.sqrt(1.0 - w) * 1.0;
    } else {
      w = 0.0;
    }
    
    return {x, y, z, w}
  }

  clonePacket() {
    const source = this.clone();
    return new Packet(this.opcode, source, this.outgoing)
  }
}

export default Packet;
