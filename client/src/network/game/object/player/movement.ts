import EventEmitter from 'events';
import { GameHandler } from '../../handler';
import GameOpcode from '../../opcode';
import GamePacket from '../../packet';
import * as THREE from 'three';
import { PlayerMovementFlag } from './enums';


// private float CalculateOrientation()
// {
//     double orientation;
//     if (X == 0)
//     {
//         if (Y > 0)
//             orientation = Math.PI / 2;
//         else
//             orientation = 3 * Math.PI / 2;
//     }
//     else if (Y == 0)
//     {
//         if (X > 0)
//             orientation = 0;
//         else
//             orientation = Math.PI;
//     }
//     else
//     {
//         orientation = Math.Atan2(Y, X);
//         if (orientation < 0)
//             orientation += 2 * Math.PI;
//     }

//     return (float)orientation;
// }

export class PlayerMovementHandler extends EventEmitter {
  private game: GameHandler;

  // Creates a new character handler
  constructor(gameHandler: GameHandler) {
    super();

    // Holds session
    this.game = gameHandler;
    // Listen for character list
    // this.game.on('packet:receive:SMSG_COMPRESSED_UPDATE_OBJECT', this.handleCompressedUpdateObjectPacket.bind(this));
    this.game.on('packet:receive:MSG_MOVE_START_FORWARD', this.handleMovement.bind(this));
    this.game.on('packet:receive:MSG_MOVE_START_BACKWARD', this.handleMovement.bind(this));
    this.game.on('packet:receive:MSG_MOVE_START_STRAFE_LEFT', this.handleMovement.bind(this));
    this.game.on('packet:receive:MSG_MOVE_START_STRAFE_RIGHT', this.handleMovement.bind(this));
    this.game.on('packet:receive:MSG_MOVE_STOP', this.handleMovement.bind(this));
    this.game.on('packet:receive:MSG_MOVE_START_TURN_LEFT', this.handleMovement.bind(this));
    this.game.on('packet:receive:MSG_MOVE_START_TURN_RIGHT', this.handleMovement.bind(this));
    this.game.on('packet:receive:MSG_MOVE_STOP_TURN', this.handleMovement.bind(this));
    
    this.game.session.player.on('moveForward', this.moveForward.bind(this));
    this.game.session.player.on('moveBackward', this.moveBackward.bind(this));
    this.game.session.player.on('strafeRight', this.strafeRight.bind(this));
    this.game.session.player.on('strafeLeft', this.strafeLeft.bind(this));
  }

  private handleMovement(packet: GamePacket) {
    const pack: any = {}
    pack.guid = packet.readPackedGUID()
    pack.flag = packet.readUnsignedInt();
    pack.flag1 = packet.readUnsignedShort();
    pack.time = packet.readUnsignedInt();
    pack.x = packet.readFloat();
    pack.y = packet.readFloat();
    pack.z = packet.readFloat();
    pack.o = packet.readFloat();
    pack.fallTime = packet.readUnsignedInt();
    console.log('handleMovement obj', pack)

    let unit = this.game.world.entities.get(pack.guid);
    if (unit) {
      unit.position.set(pack.x, pack.y, pack.z)
      unit.rotation.z = pack.o;
    }
  }

  private test = false;
  public moveForward() {
    if (!this.test) {
      this.sendMovePacket(GameOpcode.MSG_MOVE_START_FORWARD, PlayerMovementFlag.MOVEFLAG_MOVE_FORWARD);
      this.test = true;
    } else {
      this.sendMovePacket(GameOpcode.MSG_MOVE_HEARTBEAT, PlayerMovementFlag.MOVEFLAG_MOVE_FORWARD);
    }
    //this.sendMovePacket(GameOpcode.MSG_MOVE_STOP, PlayerMovementFlag.MOVEFLAG_MOVE_STOP, this.game.world.player.position, 0);
  }

  public moveBackward() {
    this.sendMovePacket(GameOpcode.MSG_MOVE_START_BACKWARD, PlayerMovementFlag.MOVEFLAG_MOVE_BACKWARD);
  }

  public strafeLeft() {
    this.sendMovePacket(GameOpcode.MSG_MOVE_START_STRAFE_LEFT, PlayerMovementFlag.MOVEFLAG_STRAFE_LEFT);
  }

  public strafeRight() {
    this.sendMovePacket(GameOpcode.MSG_MOVE_START_STRAFE_RIGHT, PlayerMovementFlag.MOVEFLAG_STRAFE_RIGHT);
  }

  public heartBeat() {
    this.sendMovePacket(GameOpcode.MSG_MOVE_HEARTBEAT, PlayerMovementFlag.MOVEFLAG_STRAFE_RIGHT);
  }

  private sendMovePacket(op: GameOpcode, flag: PlayerMovementFlag) {
    const packet = new GamePacket(op, GamePacket.OPCODE_SIZE_OUTGOING + 4 + 1 + 4 + 2*4 + 4 + 8 + 6);
    packet.writePackedGUID(this.game.world.player.guid); // should be packed
    packet.writeUnsignedInt(flag);
    packet.writeByte(0)
    packet.writeFloat(this.game.world.player.position.x);
    packet.writeFloat(this.game.world.player.position.y);
    packet.writeFloat(this.game.world.player.position.z);
    packet.writeFloat(this.game.world.player.facing);
    
    packet.writeUnsignedInt(0); //fall time
    // console.log(packet);

    this.game.send(packet);
  }
}
