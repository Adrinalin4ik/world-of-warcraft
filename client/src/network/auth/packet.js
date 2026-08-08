import AuthOpcode from './opcode';
import BasePacket from '../net/packet';
import ObjectUtil from '../../game/utils/object-util';

class AuthPacket extends BasePacket {

  // Header size in bytes for both incoming and outgoing packets
  static HEADER_SIZE = 1;

  constructor(opcode, source, outgoing = true) {
    super(opcode, source || AuthPacket.HEADER_SIZE, outgoing, AuthPacket.HEADER_SIZE);
  }

  // Retrieves the name of the opcode for this packet (if available)
  get opcodeName() {
    return ObjectUtil.keyByValue(AuthOpcode, this.opcode);
  }

  // Finalizes this packet
  finalize() {
    this.index = 0;
    this.writeByte(this.opcode);
  }

}

export default AuthPacket;
