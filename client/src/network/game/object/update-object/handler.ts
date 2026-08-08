import EventEmitter from 'events';
import * as THREE from 'three';
import zlib from 'zlib-browserify';
import Unit from '../../../../game/classes/unit';
import Packet from '../../../net/packet';
import { characterIdentityFor } from './character-identity';
import { GameHandler } from '../../handler';
import GamePacket from '../../packet';
import { getUpdateFieldName, ObjectType, UpdateFlags, UpdateType } from '../enums';

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
  async handleCompressedUpdateObjectPacket(gp: GamePacket) {
    var uncompressedLength = gp.readInt();
    gp.readByte(2); // unk junk from RFC 1950
    const buffer = gp.raw.slice(8); // remove first 9 bytes

    // https://github.com/tomrus88/WoWTools/blob/e3c4600b5f6d91c12f9014455a3e6c79158055d9/src/UpdatePacketParser/Parser.cs#L139 decompress is here
    //
    // THE CALLBACK IS THE SECOND ARGUMENT, not the third. `zlib-browserify` is not node's zlib: its
    // bundled `zlib.js:52` is `function wb(b,a,c){process.nextTick(function(){ ... a(d,f) })}` --
    // `(input, callback, options)`. Calling it node-style as `(buffer, {}, cb)` made `a` the empty
    // options object, so every single compressed update threw `a is not a function` INSIDE
    // `process.nextTick` -- an unhandled window error with no stack into this file, which is why it
    // read as noise rather than as a dropped packet. Measured on a live world entry against
    // `logon.gladewow.ru` (roster character `Gesf`): 38 `SMSG_COMPRESSED_UPDATE_OBJECT` in the first
    // 25 s, 38 throws, zero objects created. `SMSG_UPDATE_OBJECT` (the uncompressed form, 3 in the
    // same window) worked throughout, which is exactly why the handler looked wired up.
    //
    // `error` is now checked. `xb`/`vb` re-throw inside the nextTick's try, so a corrupt stream
    // arrives here as `error` set and `result` undefined; without the guard that became a
    // `new Packet(0x01F6, undefined, false)` and a second, more confusing throw.
    zlib.inflate(buffer, (error: any, result: any) => {
      if (error) {
        console.error('SMSG_COMPRESSED_UPDATE_OBJECT: inflate failed', error);
        return;
      }
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
            for (const guid of pack.farObjects) {
              const unit = this.game.world.entities.get(guid);
              if (unit) {
                unit.view.visible = false;
              }
            }
            break;
          case UpdateType.NearObjects:
            pack.nearObjects = this.parseAroundObjects(packet);
            for (const guid of pack.nearObjects) {
              const unit = this.game.world.entities.get(guid);
              if (unit) {
                unit.view.visible = true;
              }
            }
            break;
          default: 
            // The read position and what HAS parsed are both reported, because an unknown update type
            // is almost never an unknown type -- it is a desync, and the only useful question is which
            // object the cursor was inside when it happened. Reading `uf` (the update flags) off the
            // last good pack is what identified the GO_POSITION over-read: `uf: 0x350`, four bytes long.
            console.error(
              `Cannot proceed such UpdateType ${pack.updateType} at ${packet.index}/${packet.length};`
              + ` parsed so far: ${JSON.stringify(packs.map((x: any) => ({
                type: x.updateType,
                guid: x.guid,
                objType: x.obj_type,
                updateFlags: x.movement && x.movement.updateFlags,
              })))}`,
            )
            break;
        }
  
        packs.push(pack);
      }
    } catch(ex) {
      console.error(ex);
    }
    // console.log('Final obj', packs);
  }

  async applyUpdates(pack: any) {
    // if (!pack.movement.spline) return;
    // let unit: Unit = this.game.units.get(pack.guid);
    let unit = this.game.world.entities.get(pack.guid);
    // if (this.game.world.entities.size > 10) return;
    //if (pack.obj_type !== ObjectType.Player) return
    if (!unit) {
      unit = new Unit(pack.guid);
      this.game.world.add(unit);
    }

    // OUR OWN CHARACTER, and this branch is the second half of killing the duplicate.
    //
    // `readPackedGUID` now answers the same normalised hex string the roster does
    // (`network/guid-hex.ts`), so the lookup above FINDS the player the world already placed instead of
    // constructing a second `Unit` beside him. Finding him is not enough on its own, though: the two
    // writes below would then undo him.
    //
    //  - `unit.displayId` would replace the dressed character with the RACE's bare display model. For a
    //    player, `unit_field_displayid` holds `ChrRaces.maleDisplayID` (49 for a Human male) -- the same
    //    `.m2`, but resolved through the creature path, so every geoset draws at once, the body texture
    //    is the raw base skin and nothing is worn. That is exactly the placeholder this piece exists to
    //    remove, and the server re-sends the create-object every time we re-enter our own grid.
    //  - `unit.position.set` writes `view.position` while the MOVER owns position
    //    (`syncViewFromMove`), so it is undone on the next frame anyway -- and it would fight the
    //    post-teleport settle hold that keeps the body from falling through terrain that has not
    //    streamed in. The roster's position, which the world already used, is byte-identical to what
    //    this packet carries (measured: `world-entry-gate.js`).
    const isOurself = unit === this.game.world.player;

    if (pack.obj_type === ObjectType.Player && !isOurself) {
      // ANOTHER PLAYER. Same seam, driven from this object's own appearance fields rather than from a
      // roster row -- see `characterIdentityFor` for the field layout and for the one thing the wire
      // cannot give us that the roster can.
      const identity = await characterIdentityFor(pack.newObject);
      if (identity) {
        await unit.setCharacterLook(identity);
      }
    }

    if (!isOurself && !unit.hasCharacterLook) {
      unit.displayId = pack.newObject.unit_field_displayid;
    }
    // unit.displayId = 21976;

    const {x, y, z, runSpeed} = pack.movement;

    if (!isOurself) {
      unit.position.set(x, y, z);
    }
    unit.moveSpeed = runSpeed;
    const splineData = pack.movement.spline;
    const splines: THREE.Vector3[] = [];
    if (splineData) {
      splineData.splines.forEach((p: any) => {
        splines.push(new THREE.Vector3(p.x, p.y, p.z))
      });
    
      unit.setMovingData(splineData.currentTime, splines, splineData.fullTime);
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
      
      // MOVEMENTFLAG_ONTRANSPORT. NOT a fixed 21 bytes: the transport guid is PACKED, so the block is
      // 1..9 bytes of guid, four floats, a uint32 and an int8 -- plus one more uint32 when
      // MOVEMENTFLAG2_INTERPOLATED_MOVEMENT (0x0400) is set. TrinityCore 3.3.5a
      // `WorldPackets::Movement` / `Object::BuildMovementUpdate` writes exactly this order.
      if ((movement.flags & 0x00000200) >= 1) {
        movement.transport.guid = packet.readPackedGUID();
        movement.transport.position = packet.readVector3();
        movement.transport.facing = packet.readFloat();
        movement.transport.time = packet.readUnsignedInt();
        movement.transport.seat = packet.readByte();

        if ((movement.flags2 & 0x0400) >= 1) { // MOVEMENTFLAG2_INTERPOLATED_MOVEMENT
          movement.transport.time2 = packet.readUnsignedInt();
        }
      }

      if (((movement.flags & 0x00200000) >= 1) || // swiming
          ((movement.flags & 0x02000000) >= 1) || // flying
          ((movement.flags2 & 0x0020) >= 1)) { // AlwaysAllowPitching
        movement.pitch = packet.readFloat();
      }

      movement.fallTime = packet.readUnsignedInt(); //lastfalltime

      // MOVEMENTFLAG_FALLING: four floats, in the server's order -- jump velocity, then sin, then cos,
      // then the horizontal speed (TrinityCore `MovementInfo::JumpInfo`: zspeed, sinAngle, cosAngle,
      // xyspeed). The sin/cos labels were the wrong way round here as well as the wrong width.
      if ((movement.flags & 0x00001000) >= 1) {
        movement.fallVelocity = packet.readFloat();
        movement.fallSinAngle = packet.readFloat();
        movement.fallCosAngle = packet.readFloat();
        movement.fallSpeed = packet.readFloat();
      }

      if ((movement.flags & 0x04000000) >= 1) { // SPLINEELEVATION
          movement.splineElevation = packet.readFloat();
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
            // A FULL uint64, not a packed guid: `Movement::PacketBuilder::WriteCommonMonsterMoveEnd`
            // writes `data << spline.facing.target`, an ObjectGuid's raw 64 bits. Read as two uint32s
            // because the low half is the only part any caller here would use and JS numbers cannot
            // hold the whole thing exactly.
            spline.guidLow = packet.readUnsignedInt();
            spline.guidHigh = packet.readUnsignedInt();
            spline.guid = spline.guidLow;
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
      // THIS BLOCK IS 33 BYTES WITH NO TRANSPORT, AND IT DOES NOT END IN A CORPSE ORIENTATION.
      //
      // There used to be a sixth read here, `movement.corpseOrientation = packet.readFloat()`, and it
      // was FOUR BYTES OF OVER-READ on every object with UPDATEFLAG_POSITION -- which in Elwynn is
      // every door, chest and signpost. `Object::BuildMovementUpdate`'s POSITION arm writes: the
      // transport guid (packed, or a single zero byte when there is none), the world position, the
      // transport offset (the position again when there is no transport), the orientation, and the
      // transport orientation (the orientation again). Six fields, not seven.
      //
      // MEASURED, on a live entry as `Gesf`: the 2062-byte compressed update whose first object was a
      // `objType 5` with `updateFlags 0x350` (LOWGUID | STATIONARY_POSITION | POSITION | ROTATION)
      // ended that object four bytes late, so the next update-type byte read out of the middle of the
      // packed rotation as `24`, then `30`, and then `parseUpdateValues` ran the buffer dry. With this
      // read removed the same entry parses every one of its 59 update packets with zero console
      // errors. Nothing here ever wrote a corpse orientation anywhere: the field had no readers.
      movement.transport.guid = packet.readPackedGUID();
      movement.position = packet.readVector3();
      movement.transport.position = packet.readVector3();
      movement.facing = packet.readFloat();
      movement.transport.facing = packet.readFloat();

    } else if ((movement.updateFlags & UpdateFlags.UPDATEFLAG_HAS_POSITION) >= 1) { // UPDATEFLAG_HAS_POSITION
        movement.position = packet.readVector3();
        movement.facing = packet.readFloat()
    }

    // UPDATEFLAG_UNKNOWN, the `uint32(0)` `Object::BuildMovementUpdate` writes immediately before the
    // low-guid block. It was DECLARED in `UpdateFlags` and never read, so any object carrying it
    // desynced by four bytes.
    //
    // SAID PLAINLY: this flag was NOT observed on the wire in the measurement that found the other
    // defects here -- 0x252, 0x10, 0x60, 0x61 and 0x350 were the only update-flag words `gladewow`
    // sent during a world entry as `Gesf`, and none has 0x08 set. So this line is the server's
    // documented write order honoured, not a fix for a reproduced symptom, and it is inert on
    // everything measured. The over-read that DID produce the desync was in the GO_POSITION block
    // below.
    if ((movement.updateFlags & UpdateFlags.UPDATEFLAG_UNK) >= 1) {
      movement.unk = packet.readUnsignedInt();
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

  /**
   * Decode one object's update-mask block and the field values it selects.
   *
   * THE BLOCK COUNT IS UNSIGNED, and it is not read into `new Array` any more. Both of those were
   * live defects, and together they are the whole of the owner's
   * `RangeError: Invalid array length at parseUpdateValues`:
   *
   *  - `readByte()` is `getInt8`, so a count byte of 0x80 or more arrived NEGATIVE, and
   *    `new Array(negative)` throws exactly that RangeError. `readUnsignedByte()` is what the wire
   *    means -- 3.3.5a's largest block count is `(PLAYER_END + 31) / 32` = 42, so the sign bit can
   *    only ever be set on a count that is already garbage;
   *  - the array itself was allocated only to be iterated by `.length`, so it was the one place a
   *    garbage count could crash the parse rather than be reported. A plain loop cannot.
   *
   * A garbage count in the first place came from `parseMovement`, where seven `packet.readByte(N)`
   * calls were written as "skip N bytes". `readByte`'s argument is the BYTE ORDER, not a length
   * (`byte-buffer/dist/byte-buffer.js:620`, `reader('getInt8', 1)` -- `arguments[0]` is `order`), so
   * every one of them advanced ONE byte: the falling block read 4 of its 16, a spline's FINALTARGET
   * guid 1 of its 8, and `Packet#readPackedQuaternion` 1 of its 8. Each left the read cursor inside
   * the previous field, and this method is simply where the desync surfaced. All of them are fixed.
   *
   * The bounds check is kept even so: a desync is a decode bug, and being told which object and how
   * far in beats a `Cannot read 4 byte(s)` from inside byte-buffer.
   */
  parseUpdateValues(packet: Packet, type?: ObjectType) {
    const newObject: any = {}

    const blocksCount = packet.readUnsignedByte();
    let mask: number[] = [];

    if (blocksCount * 4 > packet.available) {
      throw new Error(
        `update-object: mask of ${blocksCount} blocks needs ${blocksCount * 4} bytes, `
        + `${packet.available} left (type ${type ?? 'unknown'}, at ${packet.index}/${packet.length})`,
      );
    }

    for(let i=0;i<blocksCount;++i) {
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
