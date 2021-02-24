import EventEmitter from 'events';
import { GameHandler } from '../../handler';
import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import * as THREE from 'three';
import { PlayerMovementFlag } from './enums';

export class PlayerMovementHandler extends EventEmitter {
  private game: GameHandler;

  // Creates a new character handler
  constructor(gameHandler: GameHandler) {
    super();

    // Holds session
    this.game = gameHandler;
    // Listen for character list
    // this.game.on('packet:receive:SMSG_COMPRESSED_UPDATE_OBJECT', this.handleCompressedUpdateObjectPacket.bind(this));
    // this.game.on('packet:receive:SMSG_UPDATE_OBJECT', this.handleUpdateObjectPacket.bind(this));
    
    this.game.session.player.on('moveForward', this.moveForward.bind(this));
    this.game.session.player.on('moveBackward', this.moveBackward.bind(this));
    this.game.session.player.on('strafeRight', this.strafeRight.bind(this));
    this.game.session.player.on('strafeLeft', this.strafeLeft.bind(this));
  }

  public moveForward() {
    console.log('Forward')
    this.sendMovePacket(GameOpcode.MSG_MOVE_START_FORWARD, PlayerMovementFlag.MOVEFLAG_MOVE_FORWARD, this.game.world.player.position, 0);
    this.sendMovePacket(GameOpcode.MSG_MOVE_STOP, PlayerMovementFlag.MOVEFLAG_MOVE_STOP, this.game.world.player.position, 0);
  }

  public moveBackward() {
    this.sendMovePacket(GameOpcode.MSG_MOVE_START_BACKWARD, PlayerMovementFlag.MOVEFLAG_MOVE_BACKWARD, this.game.world.player.position, 0);
  }

  public strafeLeft() {
    this.sendMovePacket(GameOpcode.MSG_MOVE_START_STRAFE_LEFT, PlayerMovementFlag.MOVEFLAG_STRAFE_LEFT, this.game.world.player.position, 0);
  }

  public strafeRight() {
    this.sendMovePacket(GameOpcode.MSG_MOVE_START_STRAFE_RIGHT, PlayerMovementFlag.MOVEFLAG_STRAFE_RIGHT, this.game.world.player.position, 0);
  }

  private sendMovePacket(op: GameOpcode, flag: PlayerMovementFlag, position: THREE.Vector3, o: number) {
    const packet = new GamePacket(op, GamePacket.OPCODE_SIZE_OUTGOING + 4 + 1 + 4 + 2*4 + 4 + 10);
    console.log(packet);
    packet.writeUnsignedInt(flag);
    packet.writeByte(255);
    packet.writeUnsignedInt(new Date().getTime());
    packet.writeFloat(position.x);
    packet.writeFloat(position.y);
    packet.writeFloat(position.z);
    packet.writeFloat(o);
    
    packet.writeUnsignedInt(0);


    this.game.send(packet);
  }
}
