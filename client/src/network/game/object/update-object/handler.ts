import EventEmitter from 'events';
import SplineType from './../spline-type';
import SplineFlag from './../spline-flag';
import { GameHandler } from '../../handler';
import zlib from 'browserify-zlib';
import Packet from '../../../net/packet';
import { getUpdateFieldName, ObjectType, UpdateFlags, UpdateType } from '../enums';
import GamePacket from '../../packet';
import Unit from '../../../../game/classes/unit';
import * as THREE from 'three';

export class UpdateObjectHandler extends EventEmitter {
  private game: GameHandler;

  // Creates a new character handler
  constructor(gameHandler: GameHandler) {
    super();

    // Holds session
    this.game = gameHandler;
    // Listen for character list
    this.game.on('packet:receive:SMSG_COMPRESSED_UPDATE_OBJECT', this.handleCompressedUpdateObjectPacket.bind(this));
    this.game.on('packet:receive:SMSG_UPDATE_OBJECT', this.handleUpdateObjectPacket.bind(this));
  }

  
  // SMSG_COMPRESSED_UPDATE_OBJECT
  handleCompressedUpdateObjectPacket(gp: GamePacket) {
    var uncompressedLength = gp.readInt();
    gp.readByte(2); // unk junk from RFC 1950
    const buffer = gp.raw.slice(8); // remove first 9 bytes

    // https://github.com/tomrus88/WoWTools/blob/e3c4600b5f6d91c12f9014455a3e6c79158055d9/src/UpdatePacketParser/Parser.cs#L139 decompress is here
    zlib.inflate(buffer, {}, (error: any, result: any) => {
      const packet = new Packet(0x01F6, result, false);
      this.handleUpdateObjectPacket(packet);
      
    });
  }

  handleUpdateObjectPacket(packet: Packet) {
    console.log('handleUpdateObjectPacket')
    const count = packet.readUnsignedInt();
    const packs = [];
    try {
      for (let i=0; i < count; i++) {
        const pack: any = {};
        pack.updateType = packet.readByte();
        switch(pack.updateType) {
          case UpdateType.Values:
            pack.guid = packet.readPackedGUID();
            pack.newObject = this.parseUpdateValues(packet);
            break;
          case UpdateType.Movement:
            console.log('Update movement')
            pack.guid = packet.readPackedGUID();
            pack.movement = this.parseMovement(packet);
            break;
          case UpdateType.CreateObject1:
          case UpdateType.CreateObject2:
            pack.guid = packet.readPackedGUID();
            pack.obj_type = packet.readByte();
            pack.movement = this.parseMovement(packet);
            pack.newObject = this.parseUpdateValues(packet, pack.obj_type);
            this.applyUpdates(pack);
            break;
          case UpdateType.FarObjects:
            pack.farObjects = this.parseAroundObjects(packet);
            break;
          case UpdateType.NearObjects:
            pack.nearObjects = this.parseAroundObjects(packet);
            break;
          default: 
            console.error(`Cannot proceed such UpdateType ${pack.updateType}`)
            break;
        }
  
        packs.push(pack);
      }
    } catch(ex) {
      console.error(ex);
    }
    console.log('Final obj', packs);
  }
  async applyUpdates(pack: any) {
    // if (!pack.movement.spline) return;
    // let unit: Unit = this.game.units.get(pack.guid);
    let unit = this.game.world.entities.get(pack.guid);
    // if (this.game.world.entities.size > 10) return;
    if (!unit) {
      unit = new Unit(pack.guid);
      this.game.world.add(unit);
    }

    if (pack.obj_type === ObjectType.Player) {
      console.log('Player', pack);
    }

    unit.displayId = pack.newObject.unit_field_displayid;

    const {x, y, z, runSpeed} = pack.movement;

    unit.position.set(x, y, z);
    unit.moveSpeed = runSpeed;
    const splineData = pack.movement.spline;
    const splines: THREE.Vector3[] = [];
    if (splineData) {
      splineData.splines.forEach((p: any) => {
        splines.push(new THREE.Vector3(p.x, p.y, p.z))
      });
    
      unit.setMovingData(splineData.currentTime, splineData.fullTime, splines);
    }
  }

  parseAroundObjects(packet: Packet) {
    const count = packet.readUnsignedInt();
    let farObjects = [];
    for(let i=0; i<count; i++) {
      farObjects.push(packet.readPackedGUID())
    }
    return farObjects;
  }

  parseMovement(packet: Packet) {
    const movement: any = {
      transport: {}
    };

    movement.updateFlags = packet.readUnsignedShort();
    if ((movement.updateFlags & UpdateFlags.UPDATEFLAG_LIVING) >= 1) { // UPDATEFLAG_LIVING
      movement.flags = packet.readUnsignedInt();
      movement.flags2 = packet.readUnsignedShort();
      movement.timeStamp = packet.readUnsignedInt();
      movement.x = packet.readFloat();
      movement.y = packet.readFloat();
      movement.z = packet.readFloat();
      movement.facing = packet.readFloat();
      
      if ((movement.flags & 0x00000200) >= 1) { // on transport
        console.log('Hrer')
        packet.readByte(21); //transporter
      }

      if (((movement.flags & 0x00200000) >= 1) || // swiming
          ((movement.flags & 0x02000000) >= 1) || // flying
          ((movement.flags2 & 0x0020) >= 1)) { // AlwaysAllowPitching
        movement.pitch = packet.readByte(4); // pitch
      }

      movement.fallTime = packet.readUnsignedInt(); //lastfalltime

      if ((movement.flags & 0x00001000) >= 1) { // if falling
        // packet.readByte(16); // skip 4 floats
        movement.fallVelocity = packet.readByte(4);
        movement.fallCosAngle = packet.readByte(4);
        movement.fallSinAngle = packet.readByte(4);
        movement.fallSpeed = packet.readByte(4);
      }

      if ((movement.flags & 0x04000000) >= 1) { // SPLINEELEVATION
          movement.splineElevation = packet.readByte(4);
      }

      // packet.readByte(32); // all of speeds
      movement.walkSpeed = packet.readFloat();
      movement.runSpeed = packet.readFloat();
      movement.runBackSpeed = packet.readFloat();
      movement.swimSpeed = packet.readFloat();
      movement.swimBackSpeed = packet.readFloat();
      movement.flySpeed = packet.readFloat();
      movement.flyBackSpeed = packet.readFloat();
      movement.turnSpeed = packet.readFloat();
      movement.pitchRate = packet.readFloat();

      if ((movement.flags & 0x08000000) >= 1) {  //spline ;/
        const spline: any = movement.spline = {};
        const splineFlags = packet.readUnsignedInt();

        // if ((splineFlags & 0x00020000) >= 1) 
        // {
        //     packet.readByte(4); // skip 1 float
        // }
        // else
        // {
        //     if ((splineFlags & 0x00010000) >= 1) // spline  FINALORIENT
        //     {
        //       spline.rotation = packet.readByte(4); // skip 1 float
        //     }
        //     else if ((splineFlags & 0x00008000) >= 1) // has FINALPOINT
        //     {
        //       spline.point = packet.readVector3();
        //     }
        // }
        if ((splineFlags & 0x00008000) >= 1) // has FINALPOINT
        {
          spline.point = packet.readVector3();
        }

        if ((splineFlags & 0x00010000) >= 1) // FINALTARGET
        {
            spline.guid = packet.readByte(8);
        }

        if ((splineFlags & 0x00020000) >= 1) // FINALORIENT
        {
          spline.rotation = packet.readFloat();
        }

        // packet.readByte(28); // skip 8 float
        spline.currentTime = packet.readUnsignedInt();
        spline.fullTime = packet.readUnsignedInt();
        spline.unk1 = packet.readUnsignedInt();

        spline.durationMultiplier = packet.readFloat();
        spline.unkfloat2 = packet.readFloat();
        spline.unkfloat3 = packet.readFloat();

        spline.unk2 = packet.readUnsignedInt();

        spline.count = packet.readUnsignedInt();

        spline.splines = [];
        for (let j = 0; j < spline.count; j++)
        {
          spline.splines.push(packet.readVector3())
        }

        spline.splineMode = packet.readByte();
        
        spline.endPoint = packet.readVector3();
      } 
    } else if ((movement.updateFlags & UpdateFlags.UPDATEFLAG_GO_POSITION) >= 1) { // if UPDATEFLAG_GO_POSITION
      // packet.ReadBytes(40);
      movement.transport.guid = packet.readPackedGUID();
      movement.position = packet.readVector3();
      movement.transport.position = packet.readVector3();
      movement.facing = packet.readFloat();
      movement.transport.facing = packet.readFloat();
      movement.corpseOrientation = packet.readFloat();

    } else if ((movement.updateFlags & UpdateFlags.UPDATEFLAG_HAS_POSITION) >= 1) { // UPDATEFLAG_HAS_POSITION
        movement.position = packet.readVector3();
        movement.facing = packet.readFloat()
    }

    if ((movement.updateFlags & UpdateFlags.UPDATEFLAG_LOWGUID) >= 1) // UPDATEFLAG_LOWGUID
    {
        // packet.ReadBytes(4);
        movement.lowGuid = packet.readUnsignedInt();
    }

    // if ((movement.updateFlags & UpdateFlags.UPDATEFLAG_HIGHGUID) >= 1) // UPDATEFLAG_HIGHGUID
    // {
    //     // packet.ReadBytes(4);
    //     movement.highGuid = packet.readUnsignedInt();
    // }

    if ((movement.updateFlags & UpdateFlags.UPDATEFLAG_TARGET_GUID) >= 1) // UPDATEFLAG_TARGET_GUID
    {
        // packet.ReadBytes(8);
        movement.attackingTarget = packet.readPackedGUID();
    }

    if ((movement.updateFlags & UpdateFlags.UPDATEFLAG_TRANSPORT) >= 1) // UPDATEFLAG_TRANSPORT
    {
        // packet.ReadBytes(4);
        movement.transportTime = packet.readUnsignedInt();
    }

    if ((movement.updateFlags & UpdateFlags.UPDATEFLAG_VEHICLE) >= 1) // UPDATEFLAG_VEHICLE
    {
        // packet.ReadBytes(8);
        movement.vehicleId = packet.readUnsignedInt();
        movement.vehicleAimAdjustement = packet.readFloat();
    }

    if ((movement.updateFlags & UpdateFlags.UPDATEFLAG_GO_ROTATION) >= 1) // UPDATEFLAG_GO_ROTATION
    {
      // packet.ReadBytes(8);
      // movement.goRotation = packet.readUnsignedByte(8);
      // movement.goRotation = packet.readVector4();
      movement.goRotation = packet.readPackedQuaternion();
    }

    return movement;
  }

  parseUpdateValues(packet: Packet, type?: ObjectType) {
    const newObject: any = {}

    const blocksCount = packet.readByte();
    let updatemask = new Array(blocksCount);
    let mask: number[] = [];

    for(let i=0;i<updatemask.length;++i) {
        // updatemask[i] = packet.readInt();
        const bitChank = (packet.readInt() >>> 0).toString(2).split(''); 
        const bitChankInversed = bitChank.reduce((acc: number[], x, i) => {
          acc.push(parseInt(bitChank[bitChank.length - 1 - i]))
          return acc;
        }, [])

        while(bitChankInversed.length < 32) {
          bitChankInversed.push(0);
        }

        mask.push(...bitChankInversed);
    }
    
    // console.log(updatemask, mask);
    for (let i=0; i<mask.length; i++) {
      if (mask[i] === 1) {
        // newObject[convertEnum(i, 'PLAYER')] = packet.readUnsignedInt();
        if (type) {
          newObject[getUpdateFieldName(i, type)] = packet.readUnsignedInt();
        } else {
          newObject[i] = packet.readUnsignedInt();
        }
      }
    }

    return newObject;
  }
}
