export default class GUID {

  // GUID byte-length (64-bit)
  static LENGTH = 8;

  raw: any;
  low: any;
  high: any;

  // Creates a new GUID
  constructor(buffer: any) {

    // Holds raw byte representation
    this.raw = buffer;

    // Holds low-part
    this.low = buffer.readUnsignedInt();

    // Holds high-part
    this.high = buffer.readUnsignedInt();

  }

  // Short string representation of this GUID
  toString() {
    const high = ('00000000' + this.high.toString(16)).slice(-8);
    const low = ('00000000' + this.low.toString(16)).slice(-8);
    return `[GUID; Hex: 0x${high}${low}]`;
  }

}
