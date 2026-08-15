import ByteBuffer from 'byte-buffer';
import GUID from '../game/guid';
import { GUID_BYTES, guidBytes, guidHex, normaliseGuid } from '../guid-hex';
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

  /**
   * A null-terminated string that ALWAYS consumes its terminator.
   *
   * **`byte-buffer`'s own `readCString` does not.** Read it (`byte-buffer/dist/byte-buffer.js:371-388`):
   * it scans to the null, and when the run length is zero it `return null` WITHOUT advancing the
   * index. So a non-empty string costs `length + 1` bytes and an EMPTY one costs **zero**. Every
   * caller that reads a fixed number of strings and then keeps reading is desynced by one byte per
   * empty string, and the desync is invisible at the first string -- which is always the populated
   * one, and always the one a developer spot-checks.
   *
   * This was MEASURED, not reasoned about. `SMSG_ITEM_QUERY_SINGLE_RESPONSE` carries four name slots
   * of which the server fills one, and the three empty ones cost 0 bytes instead of 3: Hearthstone's
   * `displayInfoID` came back `0x12000000` where the true value is `6418 = 0x1912`, i.e. the read
   * landed exactly three bytes early, and `quality` came back `0x01000019` -- the tail of the display
   * id with the real quality byte `0x01` sitting in the top byte. The name decoded perfectly in the
   * same packet, which is precisely why nothing noticed.
   *
   * `''`, not `null`, for the empty case: a decoder that reads a name should get a string.
   */
  readCStr() {
    const value = this.readCString();
    if (value === null) {
      // The empty case. Consume the terminator byte that `readCString` left behind -- unless the
      // buffer is genuinely exhausted, where advancing would throw on a packet that simply ended.
      if (this.available > 0) {
        this.readUnsignedByte();
      }
      return '';
    }
    return value;
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

  /**
   * Write a guid in the server's packed form: a one-byte mask, then only the non-zero bytes.
   *
   * TAKES THE NORMALISED HEX STRING (`network/guid-hex.ts`), which is what every guid in this client
   * now is. The previous body took a `{low, high}` pair and wrote a FIXED eight-byte blob --
   * `[3, raw[0], raw[1], 1, raw[5], raw[6], 0, 0]` -- whose mask bytes and payload bytes did not
   * correspond to each other at all, and whose only caller (`player/movement.ts:116`) hands it
   * `world.player.guid`, a STRING. So `guid.low` was `undefined`, `writeUnsignedInt(undefined)` wrote
   * garbage, and the mask claimed bytes 0 and 1 plus a stray `1`/`0` pair. It could never have
   * produced a guid the server would accept. Movement networking is not in scope here, but the
   * REPRESENTATION is, and leaving one half of it converted would have been worse than either state.
   *
   * The mask is `1 << i` per non-zero byte, low byte first, exactly as `readPackedGUID` reads it and
   * as the Pascal reference transcribed above writes it.
   */
  writePackedGUID(guid) {
    const bytes = guidBytes(typeof guid === 'string' ? guid : normaliseGuid(guid));
    let mask = 0;
    const payload = [];
    for (let i = 0; i < GUID_BYTES; ++i) {
      if (bytes[i] !== 0) {
        mask |= 1 << i;
        payload.push(bytes[i]);
      }
    }
    this.write([mask, ...payload]);
    return this;
  }

  // // Reads packed GUID from this packet
  // // TODO: Implementation
  // readPackedGUID: ->
  //   return null

  /**
   * Read a packed guid and answer the NORMALISED HEX STRING, not a number.
   *
   * WHAT WAS WRONG, and it is the blocker two prior reports named. The body used to accumulate
   * `guid |= bit << (i * 8)` into a `var guid = 0`. `|` coerces both operands to **int32**, so:
   *   - byte 3 with its high bit set produced a NEGATIVE guid (`-250601794` is in the owner's log);
   *   - `bit << 24` for i >= 4 shifts by 32/40/... which JS masks to `& 31`, i.e. bytes 4..7 were
   *     folded back over bytes 0..3 -- a silent collision, not a truncation;
   *   - so `World#entities` (`Map<string, Unit>`) was keyed by these numbers while the player was
   *     keyed by the roster's hex string, they could never match, and the server's create-object for
   *     our own character made a SECOND `Unit` beside the one the world had placed. That is the
   *     duplicate player, and this line is its whole cause.
   *
   * Bytes the mask does not select are ZERO, which is exactly `guidHex`'s zero-extension.
   */
  readPackedGUID() {
      const guidMark = this.readUnsignedByte();
      const bytes = new Uint8Array(GUID_BYTES);

      for (let i = 0; i < GUID_BYTES; ++i)
      {
          if(guidMark & (1 << i))
          {
              if(this.index + 1 > this.length)
                  throw new Error(`Buffer exception ${this.index} >= ${this.length}`);

              bytes[i] = this.readUnsignedByte();
          }
      }

      return guidHex(bytes);
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
