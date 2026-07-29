import EventEmitter from 'events';
import SplineType from './../spline-type';
import SplineFlag from './../spline-flag';
import { GameHandler } from '../../handler';
import GamePacket from '../../packet';
import Unit from '../../../../game/classes/unit';
import * as THREE from 'three';
import GameOpcode from '../../opcode';

export class MonsterMovementtHandler extends EventEmitter {
  private game: GameHandler;

  // Creates a new character handler
  constructor(gameHandler: GameHandler) {
    super();

    // Holds session
    this.game = gameHandler;
    // Listen for character list
    // this.game.on('packet:receive:SMSG_MONSTER_MOVE', this.handleMonsterMove.bind(this));
    // this.game.on('packet:receive:SMSG_MONSTER_MOVE_TRANSPORT', this.handleMonsterMove.bind(this));
  }

  handleMonsterMove(packet: GamePacket) {
    const pack: any ={};
    pack.guid = packet.readPackedGUID();

    if (packet.opcode === GameOpcode.SMSG_MONSTER_MOVE_TRANSPORT) {
      pack.transportGUID = packet.readPackedGUID();
      pack.transportSeat = packet.readByte();
    }

    pack.unk1 = packet.readByte();

    pack.currentPosition = packet.readVector3();
    pack.ticksCount = packet.readUnsignedInt();

    pack.splineType = packet.readByte();

    switch(pack.splineType) {
      case SplineType.Normal:
        break;
      case SplineType.Stop:
        return;
      case SplineType.FacingSpot:
        pack.facingPoint = packet.readVector3();
        break;
      case SplineType.FacingTarget:
        pack.FacingTarget = packet.readByte(8);
        break;
      case SplineType.FacingAngle:
        pack.facingAngle = packet.readFloat();
        break;
      default: break;
    }

    pack.splineFlags = packet.readUnsignedInt();

    if ((pack.splineFlag & SplineFlag.Unknown3) > 1) {
      pack.animationType =  packet.readByte();
      pack.animationTime = packet.readUnsignedInt();
    }

    pack.currentTime = packet.readUnsignedInt();
    
    if ((pack.splineFlag & SplineFlag.Trajectory) > 1) {
      pack.unk_float_0x800 = packet.readFloat();
      pack.unk_int_0x800 = packet.readUnsignedInt();
    }

    pack.splinesCount = packet.readUnsignedInt();
    pack.splines = [];
    if ((pack.splineFlags & SplineFlag.Flying) > 1 || (pack.splineFlags & SplineFlag.CatmullRom) > 1) {
      pack.startPosition = packet.readVector3();

      if (pack.splinesCount > 1) {
        for (let i=0; i< pack.splinesCount - 1; i++) {
          pack.splines.push(packet.readVector3());
        }
      }
    } else {
      pack.destination = packet.readVector3();
      pack.mid = new THREE.Vector3();

      pack.mid.x = (pack.currentPosition.x + pack.destination.x) * 0.5;
      pack.mid.y = (pack.currentPosition.y + pack.destination.y) * 0.5;
      pack.mid.z = (pack.currentPosition.z + pack.destination.z) * 0.5;

      if (pack.splinesCount > 1) {
        for (let i=0; i< pack.splinesCount - 1; i++) {
          pack.packedOffset = packet.readUnsignedInt();

          const x = ((pack.packedOffset & 0x7FF) << 21 >> 21) * 0.25;
          const y = ((((pack.packedOffset >> 11) & 0x7FF) << 21) >> 21) * 0.25;
          const z = ((pack.packedOffset >> 22 << 22) >> 22) * 0.25;

          pack.splines.push(new THREE.Vector3(pack.mid.x + x, pack.mid.y + y, pack.mid.z + z));

          // перепроверка
          let packed = 0;
          packed |= ((x / 0.25) & 0x7FF);
          packed |= ((y / 0.25) & 0x7FF) << 11;
          packed |= ((z / 0.25) & 0x3FF) << 22;

          if (pack.packedOffset !== packed) {
            console.error("Not equal!");
          }
        }
      }
    }
    
    this.applyUpdates(pack);
  }

  applyUpdates(pack:any) {
    const unit = this.game.world.entities.get(pack.guid);
    if (unit) {
      unit.position.set(pack.currentPosition.x, pack.currentPosition.y, pack.currentPosition.z);
      unit.setMovingData(pack.currentTime, pack.splines);
    }
  }
}
