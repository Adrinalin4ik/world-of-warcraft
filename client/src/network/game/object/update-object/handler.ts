import EventEmitter from 'events';
import zlib from 'zlib-browserify';
import Unit from '../../../../game/classes/unit';
import Packet from '../../../net/packet';
import { characterIdentityFor } from './character-identity';
import { GameHandler } from '../../handler';
import GamePacket from '../../packet';
import { getUpdateFieldName, ObjectType, UpdateFlags, UpdateType } from '../enums';
import { readMovementInfo } from '../../movement-info';
import { GUID_BYTES, guidHex } from '../../../guid-hex';
import { objectTrace } from './trace';

/**
 * One reusable 4-byte window for reinterpreting a float update field's raw bits.
 *
 * `parseUpdateValues` reads every field with `readUnsignedInt`, which is right for the great
 * majority of them and wrong for the handful that are floats on the wire. Module scope rather than
 * per-packet so a grid full of units does not allocate two typed arrays each.
 */
const SCALE_BITS = new Uint32Array(1);
const SCALE_FLOAT = new Float32Array(SCALE_BITS.buffer);

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
    // `SMSG_DESTROY_OBJECT` (0x0AA) has been in the opcode table (`game/opcode.js:172`) with NO
    // subscriber anywhere in the client -- the packet was framed, named, emitted and dropped in
    // silence. It is the other half of the lifecycle from the out-of-range block: out-of-range says
    // "you left its range", destroy says "it ceased to exist" (a despawn, a corpse decaying before
    // its respawn). Without it, every mob this client ever saw die stayed standing for ever.
    this.game.on('packet:receive:SMSG_DESTROY_OBJECT', this.handleDestroyObjectPacket.bind(this));
  }

  /**
   * SMSG_DESTROY_OBJECT: `uint64 guid`, then a `uint8` "on death" flag this client has no use for.
   *
   * A PLAIN u64, NOT a packed guid -- `readPackedGUID` here would both build the wrong key and read
   * the wrong number of bytes. (`samples/benilla/crates/benilla-protocol/src/messages/parse.rs:181`
   * and its `update_object.rs`; `objects.rs#object_destroyed` is the reference behaviour, an instant
   * removal with no fade.) The eight bytes go straight through `guidHex`, which is the single
   * formatter every other guid in this client is normalised by (`network/guid-hex.ts`), so this key
   * and the create path's key are the same string.
   *
   * Byte at a time, deliberately. `Packet#read(n)` returns a NEW ByteBuffer WRAPPING the slice, not
   * the bytes -- a ByteBuffer is not array-like, so `guidHex(gp.read(8))` would read `undefined` at
   * every index, zero-extend all eight, and answer `0x0` for every object in the game. That trap has
   * already cost this project twice (`protocol/wotlk/world.ts:296` and `logon.ts:264` both carry the
   * same warning), and `readPackedGUID` reads its bytes the same way for the same reason.
   */
  handleDestroyObjectPacket(gp: GamePacket) {
    const bytes = new Uint8Array(GUID_BYTES);
    for (let i = 0; i < GUID_BYTES; ++i) {
      bytes[i] = gp.readUnsignedByte();
    }
    const guid = guidHex(bytes);
    const unit = this.game.world.entities.get(guid);
    objectTrace.record({ t: performance.now(), kind: 'destroy', guid, existing: !!unit });
    if (unit && unit !== this.game.world.player) {
      this.game.world.remove(unit);
    }
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
            // A movement-only update: no values block, just a new `MovementInfo` for an object we
            // already have. It was PARSED and then thrown away, so a unit whose only motion came
            // through this door never moved. Routed to the same peer interpolator as `MSG_MOVE_*`.
            pack.guid = packet.readPackedGUID();
            pack.movement = this.parseMovement(packet);
            this.applyMovementOnly(pack);
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
            // STREAM-OUT. A REMOVAL, not a hide, and that is the whole of "NPCs vanish and never
            // come back".
            //
            // This used to set `unit.view.visible = false` and leave the unit in `World#entities`.
            // Nothing ever set it back. The only code that raised the flag again was
            // `UpdateType.NearObjects` below, and a 3.3.5a server does not send those -- the way an
            // object comes BACK into range is a fresh `CreateObject2` block, and `applyUpdates`
            // finds the guid already in the registry, takes its "already have it" branch and never
            // touches visibility. So the first stream-out was permanent: the unit stayed in the
            // scene, kept being posed every frame, kept applying the server's movement, and was
            // invisible for the rest of the session.
            //
            // The reference removes it (`samples/benilla/crates/benilla/src/net/apply/objects.rs`,
            // `objects_removed`: "the unit still exists, we just left its range" -- it drops the
            // entity from the guid index and despawns it, and a later create streams it back in as
            // a fresh entity). This does the same, which also means re-entry runs the exact path
            // that first sight already runs and is known to work.
            pack.farObjects = this.parseAroundObjects(packet);
            for (const guid of pack.farObjects) {
              const unit = this.game.world.entities.get(guid);
              objectTrace.record({ t: performance.now(), kind: 'far', guid, existing: !!unit });
              // Never ourselves. The server has no reason to put our own guid in an out-of-range
              // list, and removing the local player would take the camera's subject out of the
              // scene -- a guard, not an observed case.
              if (unit && unit !== this.game.world.player) {
                this.game.world.remove(unit);
              }
            }
            break;
          case UpdateType.NearObjects:
            // Kept, and expected never to fire: no 3.3.5a core is observed to emit this block, and
            // the trace records it precisely so that "it never arrives" stays a MEASUREMENT rather
            // than an assumption -- the previous code leaned on it as the way a unit came back, and
            // that is what made the stream-out permanent. Raising the flag is still right if one
            // ever does arrive; it is no longer the only thing that could.
            pack.nearObjects = this.parseAroundObjects(packet);
            for (const guid of pack.nearObjects) {
              const unit = this.game.world.entities.get(guid);
              if (unit) {
                unit.view.visible = true;
              }
              objectTrace.record({ t: performance.now(), kind: 'near', guid, existing: !!unit });
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

  /**
   * `UpdateType.Movement`: a position for an object that already exists. Interpolated exactly like a
   * `MSG_MOVE_*` relay -- it is the same `MovementInfo`, arriving through the update stream instead
   * of as its own message -- except for the spline tail, which is a whole path and takes over.
   */
  applyMovementOnly(pack: any) {
    const unit = this.game.world.entities.get(pack.guid);
    if (!unit || unit === this.game.world.player) {
      return;
    }
    const m = pack.movement;
    if (m.spline && Array.isArray(m.spline.splines) && m.spline.splines.length >= 2) {
      unit.setSplinePath(m.spline.splines, m.spline.fullTime, false, {
        timePassedMs: m.spline.currentTime,
        finalFacing: typeof m.spline.rotation === 'number' ? m.spline.rotation : null,
      });
      return;
    }
    if (typeof m.x === 'number') {
      unit.applyRemoteState({ x: m.x, y: m.y, z: m.z }, m.facing ?? unit.rotation.z, m.flags ?? 0);
    }
  }

  async applyUpdates(pack: any) {
    // if (!pack.movement.spline) return;
    // let unit: Unit = this.game.units.get(pack.guid);
    let unit = this.game.world.entities.get(pack.guid);
    // if (this.game.world.entities.size > 10) return;
    //if (pack.obj_type !== ObjectType.Player) return
    const existing = !!unit;
    if (!unit) {
      unit = new Unit(pack.guid);
      this.game.world.add(unit);
    }
    objectTrace.record({
      t: performance.now(),
      kind: 'create',
      guid: pack.guid,
      existing,
      visible: unit.view.visible,
    });

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

    // OBJECT_FIELD_SCALE_X -- the unit's render scale, and the ONLY thing the reference client sizes
    // a unit by (`benilla/crates/benilla/src/entities/attach/mod.rs:711-717`; see `Unit#objectScale`
    // for the quotation and for the measurement that settled it against this realm). Reinterpreted
    // rather than converted: `parseUpdateValues` reads every field with `readUnsignedInt`, so a float
    // column arrives as its IEEE-754 bit pattern and `Number` conversion would give ~1.06e9 for 1.0.
    //
    // BEFORE the display-id assignment on purpose. `set displayId` starts the resolve that applies
    // the scale, so a scale that arrived in the same values block must already be on the unit; a
    // scale that arrives LATER, in a values-only update for a body already drawn, is handled by the
    // `applyRenderScale()` call in the setter below.
    if (typeof pack.newObject.object_field_scale_x === 'number') {
      SCALE_BITS[0] = pack.newObject.object_field_scale_x >>> 0;
      const scale = SCALE_FLOAT[0];
      if (Number.isFinite(scale) && scale > 0) {
        unit.objectScale = scale;
        unit.applyRenderScale();
      }
    }

    if (!isOurself && !unit.hasCharacterLook) {
      unit.displayId = pack.newObject.unit_field_displayid;
    }
    // unit.displayId = 21976;

    const {x, y, z, runSpeed, facing} = pack.movement;

    if (!isOurself) {
      unit.position.set(x, y, z);
      if (typeof facing === 'number') {
        unit.rotation.z = facing;
      }
    }
    unit.moveSpeed = runSpeed;

    // THE WALK THIS UNIT IS ALREADY RIDING when it streams into view -- the create block's
    // MOVEMENTFLAG_SPLINE_ENABLED tail. Its points are absolute and its `currentTime` is how much
    // of the ride the server has ALREADY covered, so the ride is back-dated by that much and the
    // unit joins the walk in progress instead of restarting it from the top. Restarting it (which
    // is what the previous `setMovingData(currentTime, ...)` did, since nothing downstream read
    // `currentTime` as a time at all) puts a creature back where it was seconds ago, and its next
    // `SMSG_MONSTER_MOVE` then snaps it forward.
    const splineData = pack.movement.spline;
    if (splineData && !isOurself && Array.isArray(splineData.splines)) {
      unit.setSplinePath(splineData.splines, splineData.fullTime, false, {
        timePassedMs: splineData.currentTime,
        finalFacing: typeof splineData.rotation === 'number' ? splineData.rotation : null,
      });
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
      // The `MovementInfo` head, which is byte-for-byte the body of every `MSG_MOVE_*` message and
      // is now decoded in ONE place (`network/game/movement-info.ts`). The two used to be separate
      // transcriptions of the same structure and only this one had the optional blocks.
      //
      // `false`: the guid was already read as this update block's own head. Reading a second one
      // here would eat the flags word.
      const info = readMovementInfo(packet, false);
      Object.assign(movement, info, { transport: info.transport ?? movement.transport });

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
