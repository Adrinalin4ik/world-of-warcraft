import ByteBuffer from 'byte-buffer';
import GUID from '../game/guid';
window['ByteBuffer'] = ByteBuffer;
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

  // procedure TPacket.PutCompressed(const Value: TWoWGuid);
  //   var
  //     MaskPos: Integer;
  //     i: Byte;
  //   begin
  //     MaskPos := WritePos;
  //     Inc(FWritePos, 2); // add space for 2 masks

  //     for i := 0 to SizeOf(Value.Low) - 1 do
  //     begin
  //       if (Int64Rec(Value.Low).Bytes[i] > 0) then
  //       begin
  //         FBuffer[MaskPos] := FBuffer[MaskPos] or 1 shl i; // low mask
  //         PutUInt8(Int64Rec(Value.Low).Bytes[i]);
  //       end;
  //     end;

  //     for i := 0 to SizeOf(Value.High) - 1 do
  //     begin
  //       if (Int64Rec(Value.High).Bytes[i] > 0) then
  //       begin
  //         FBuffer[MaskPos+1] := FBuffer[MaskPos+1] or 1 shl i; // high mask
  //         PutUInt8(Int64Rec(Value.High).Bytes[i]);
  //       end;
  //     end;
  //   end;

  writePackedGUID(guid) {
    const buffer = new ByteBuffer(8, -1);
    buffer.writeUnsignedInt(guid.low);
    buffer.writeUnsignedInt(guid.high);

    this.write([3, buffer.raw[0], buffer.raw[1], 1, buffer.raw[5], buffer.raw[6], 0, 0])
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

  /**
   * A 3.3.5a packed quaternion -- 64 bits, three signed fields, `SMSG_UPDATE_OBJECT`'s
   * UPDATEFLAG_GO_ROTATION.
   *
   * TWO FIXES, and the first one is a wire defect rather than a maths one. This read
   * `this.readByte(8)`, and `readByte`'s argument is the BYTE ORDER, not a length
   * (`byte-buffer/dist/byte-buffer.js:620` is `reader('getInt8', 1)`), so it consumed ONE of the eight
   * bytes. Every game object with a rotation -- which in Elwynn is every door, chest and signpost --
   * left the read cursor seven bytes short, and the next object's mask block count was then read out
   * of the middle of this quaternion. That is what produced `RangeError: Invalid array length` in
   * `parseUpdateValues`.
   *
   * Second, the shifts. The three fields are 22 / 21 / 21 bits, so `>>` on a JS number cannot express
   * them: `>>` coerces to int32 and every bit above 31 is gone. BigInt does the shifts at full width
   * and each field is sign-extended by shifting left to the top and back down, exactly as
   * `G3D::Quat::unpack` does.
   */
  readPackedQuaternion() {
    const low = BigInt(this.readUnsignedInt() >>> 0);
    const high = BigInt(this.readUnsignedInt() >>> 0);
    const packed = BigInt.asIntN(64, (high << 32n) | low);

    let x = Number(packed >> 42n) * (1.0 / 2097152.0);
    let y = Number(BigInt.asIntN(64, packed << 22n) >> 43n) * (1.0 / 1048576.0);
    let z = Number(BigInt.asIntN(64, packed << 43n) >> 43n) * (1.0 / 1048576.0);

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
