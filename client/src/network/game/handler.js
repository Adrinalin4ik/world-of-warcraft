import ByteBuffer from 'byte-buffer';

import BigNum from '../crypto/big-num';
import Crypt from '../crypto/crypt';
import GameOpcode from './opcode';
import GamePacket from './packet';
import GUID from './guid';
import SHA1 from '../crypto/hash/sha1';
import Socket from '../net/socket';
import ChatEnum from './chat/chatEnum';
import config from '../config';
import { ObjectHandler } from './object/handler';
import { clientTicks, encodeTimeSyncResponse } from './time-sync';
import World from '../../game/world';
import { Camera } from 'three';

export class GameHandler extends Socket {

  static pingRecv = true;

  // Creates a new game handler
  constructor(session) {
    super();
    // Holds session
    this.session = session;
    this.objectHandler = new ObjectHandler(this);

    this.authenticated = false;
    // [guid] = name
    this.playerNames = [];

    this.playerNames[0] = { name: 'SYSTEM' };

    this.units = new Map();

    // Listen for incoming data
    this.on('data:receive', this.dataReceived.bind(this));

    // Delegate packets
    this.on('packet:receive:SMSG_PONG', this.handlePong.bind(this));
    this.on('packet:receive:SMSG_AUTH_CHALLENGE', this.handleAuthChallenge.bind(this));
    this.on('packet:receive:SMSG_AUTH_RESPONSE', this.handleAuthResponse.bind(this));
    this.on('packet:receive:SMSG_LOGIN_VERIFY_WORLD', this.handleWorldLogin.bind(this));
    this.on('packet:receive:SMSG_NAME_QUERY_RESPONSE', this.handleName.bind(this));
    this.on('packet:receive:SMSG_TIME_SYNC_REQ', this.handleTimeSyncRequest.bind(this));
    this.camera = null;
    this.world = new World(this);
  }

  // Connects to given host through given realm information
  connect(host, realm) {
    this.realm = realm;
    if (!this.connected) {
      super.connect(host, realm.port);
      console.info('connecting to game-server @', this.host, ':', this.port);
    }
    return this;
  }

  // Finalizes and sends given packet
  send(packet) {
    const size = packet.bodySize + GamePacket.OPCODE_SIZE_OUTGOING;

    packet.front();
    packet.writeShort(size, ByteBuffer.BIG_ENDIAN);
    packet.writeUnsignedInt(packet.opcode);

    // Encrypt header if needed
    if (this._crypt) {
      this._crypt.encrypt(new Uint8Array(packet.buffer, 0, GamePacket.HEADER_SIZE_OUTGOING));
    }
    return super.send(packet);
  }

  // Attempts to join game with given character
  join(character) {
    this.session.player.name = character.name;
    this.session.player.guid = character.guid;

    this.playerNames[character.guid.low] = {
      name: character.name
    };

    if (character) {
      console.info('joining game with', character);

      const gp = new GamePacket(GameOpcode.CMSG_PLAYER_LOGIN, GamePacket.HEADER_SIZE_OUTGOING + GUID.LENGTH);
      gp.writeGUID(character.guid);
      Object.assign(this.session.player, character);
      const player = this.session.player
      player.remote = true;
      player.worldport(character.map, [character.x, character.y, character.z]);
      this.authenticated = true;
      // this.session.world.connect();
      return this.send(gp);
    }

    return false;
  }

  // Data received handler
  dataReceived(_socket) {
    while (true) {
      if (!this.connected) {
        return;
      }
      let isLarge = false;
      if (this.remaining === false) {

        if (this.buffer.available < GamePacket.HEADER_SIZE_INCOMING) {
          return;
        }

        // Decrypt header if needed
        if (this._crypt) {
          this._crypt.decrypt(new Uint8Array(this.buffer.buffer, this.buffer.index, GamePacket.HEADER_SIZE_INCOMING));
        }

        const firstByte = this.buffer.raw[this.buffer.index];
        isLarge = firstByte & GamePacket.LARGE_PACKET_FLAG;

        if (isLarge) {
          this._crypt.decrypt(new Uint8Array(this.buffer.buffer, this.buffer.index +  GamePacket.HEADER_SIZE_INCOMING, 1));
          this.remaining = this.buffer.readUnsignedByte(ByteBuffer.BIG_ENDIAN) | this.buffer.readUnsignedShort(ByteBuffer.BIG_ENDIAN);
        } else {
          this.remaining = this.buffer.readUnsignedShort(ByteBuffer.BIG_ENDIAN);
        }
      }

      if (this.remaining > 0 && this.buffer.available >= this.remaining) {
        const size = GamePacket.OPCODE_SIZE_INCOMING + this.remaining;
        const gp = new GamePacket(this.buffer.readUnsignedShort(), this.buffer.seek(-GamePacket.HEADER_SIZE_INCOMING).read(size), false, isLarge);

        this.remaining = false;

        // console.log('⟹', gp.toString());
        // console.debug gp.toHex()
        // console.debug gp.toASCII()

        this.emit('packet:receive', gp);
        if (gp.opcodeName) {
          this.emit(`packet:receive:${gp.opcodeName}`, gp);
        }

      } else if (this.remaining !== 0) {
        return;
      }
    }
  }

  handleName(gp) {
    const guid = gp.readPackedGUID();
    const name_known = gp.readUnsignedByte();
    const name = gp.readCString();
    const realm = gp.readCString(); // only for crossrealm

    const race = gp.readUnsignedByte();
    const gender = gp.readUnsignedByte(); // guid2
    const playerClass = gp.readUnsignedByte();
    const declined = gp.readUnsignedByte();

    this.session.player.name = name;

    this.playerNames[guid] = {
      name
        // race : race,
        // gender : gender,
        // playerClass : playerClass
    };

    this.session.chat.emit('message', null); // to refresh
  }

  askName(guid) {
    const app = new GamePacket(GameOpcode.CMSG_NAME_QUERY, 64);

    app.writeGUID(guid);

    this.session.game.send(app);
    return true;
  }

  /**
   * SMSG_TIME_SYNC_REQ (0x390) -> CMSG_TIME_SYNC_RESP (0x391).
   *
   * The server asks on a ten-second beat from world entry onwards and this client answered none of
   * them; `game/time-sync.ts` carries the measurement that made this the suspect. The request body is
   * the counter alone (the packet is 8 bytes: a 4-byte incoming header and a 4-byte body).
   *
   * The read cursor is where the framing left it -- `Packet`'s constructor seeks past the header --
   * and no other listener is registered for this opcode, so no rewind is needed here. (The adapter in
   * `protocol/wotlk/world.ts` rewinds because it SHARES packets with the handlers above it; that
   * hazard is real and is why this note exists.)
   */
  handleTimeSyncRequest(gp) {
    const counter = gp.readUnsignedInt();
    const body = encodeTimeSyncResponse(counter, clientTicks());

    const app = new GamePacket(
      GameOpcode.CMSG_TIME_SYNC_RESP,
      GamePacket.HEADER_SIZE_OUTGOING + body.length,
    );
    app.write(Array.from(body));

    this.send(app);
  }

  // Pong handler (SMSG_PONG)
  handlePong(gp) {
    console.log('pong');
    this.pingRecv = true;
    var ping = gp.readUnsignedInt(); // (0x01)
  }

  ping() {
    console.log('ping');
    if (this.pingRecv === false) {
      this.disconnect();
    }

    const app = new GamePacket(GameOpcode.CMSG_PING, GamePacket.OPCODE_SIZE_INCOMING + 64);
    app.writeUnsignedInt(1);      // ping ( unknown value)
    app.writeUnsignedInt(10);     // latency, 10ms for now

    this.pingRecv = false;

    this.send(app);
  }

  // Auth challenge handler (SMSG_AUTH_CHALLENGE)
  handleAuthChallenge(gp) {
    console.info('handling auth challenge');

    gp.readUnsignedInt(); // (0x01)

    const salt = gp.read(4);

    const seed = BigNum.fromRand(4);

    const hash = new SHA1();
    hash.feed(this.session.auth.account);
    hash.feed([0, 0, 0, 0]);
    hash.feed(seed.toArray());
    hash.feed(salt);
    hash.feed(this.session.auth.key);

    const build = config.build;
    const account = this.session.auth.account;
    const size = GamePacket.HEADER_SIZE_OUTGOING + 8 + this.session.auth.account.length + 1 + 4 + 4 + 20 + 20 + 4;

    const app = new GamePacket(GameOpcode.CMSG_AUTH_SESSION, size);
    app.writeUnsignedInt(build); // build
    app.writeUnsignedInt(0);     // (?)
    app.writeCString(account);   // account
    app.writeUnsignedInt(0);     // (?)
    app.write(seed.toArray());   // client-seed
    app.writeUnsignedInt(0);     // (?)
    app.writeUnsignedInt(0);     // (?)
    app.writeUnsignedInt(this.realm.id);     // realmid
    app.writeUnsignedInt(0);     // (?)
    app.writeUnsignedInt(0);     // (?)
    app.write(hash.digest);      // digest
    app.writeUnsignedInt(0);     // addon-data

    console.log('Account', app)
    this.send(app);

    this._crypt = new Crypt();
    this._crypt.key = this.session.auth.key;
  }

  // Auth response handler (SMSG_AUTH_RESPONSE)
  handleAuthResponse(gp) {
    console.info('handling auth response');

    // ONLY 0x0C is success.
    //
    // This used to special-case 0x0D and 0x15 and treat everything else as a pass, so a real server
    // answering 0x0E (AUTH_REJECT) was reported as "authenticate" and the client went on to request
    // the character list on a connection the server was already closing. The full table is
    // `WORLD_RESULT_STRINGS` in `network/protocol/stages.ts`, and the two codes named here were also
    // mislabelled: 0x15 is AUTH_UNKNOWN_ACCOUNT, not "account in use".
    const result = gp.readUnsignedByte();
    if (result !== 0x0c) {
      console.warn(`world handshake refused: 0x${result.toString(16)}`);
      this.emit('reject', result);
      return;
    }

    this.emit('authenticate');
  }

  // World login handler (SMSG_LOGIN_VERIFY_WORLD)
  handleWorldLogin(_gp) {

    setInterval(() => {
      this.ping();
    }, 50000);

    this.joinWorldChannel();
    this.emit('join');
  }

  joinWorldChannel() {
    console.log('join world');

    const channel = ChatEnum.channel;
    const pass = '';

    const size = 1 + 16 +  4 + 4 + channel.length + pass.length;
    const app = new GamePacket(GameOpcode.CMSG_JOIN_CHANNEL, size);
    app.writeUnsignedInt(0);
    app.writeByte(0);
    app.writeByte(0);
    app.writeString(channel);
    app.writeString(pass);

    this.session.game.send(app);
    return true;
  }

}
