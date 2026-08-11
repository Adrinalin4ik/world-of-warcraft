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
import { readAuthResponseExpansion } from './account-info';
import World from '../../game/world';
import { Camera } from 'three';

/**
 * The keepalive period. The reference client's, and benilla's
 * (`samples/benilla/crates/benilla/src/net/io.rs:87`, `PING_INTERVAL = 30 s`, itself verified against
 * the real client's 30 000 ms ping timer at `0x537ff0`).
 */
const PING_INTERVAL_MS = 30000;

/**
 * The floor a `CMSG_PING` may never cross, and it is a SERVER rule, not a preference.
 *
 * The mangos family's `WorldSocket::_HandlePing` counts every ping that arrives less than 27 s after
 * the previous one on the same socket and closes the connection once the count passes
 * `MAX_OVERSPEED_PINGS` (2). benilla records the same constant and the same reason at `net/io.rs:81-84`
 * ("vmangos *kicks* a player socket whose pings repeat faster than 27 s apart more than twice").
 *
 * MEASURED on `logon.gladewow.ru`, twice, on two different accounts (`scratchpad/S4-net.txt`,
 * `S7-net.txt`): with pings forced to 10-15 s apart, pings 1-3 were answered with `SMSG_PONG` and
 * ping 4 was not -- the realm sent its FIN 2.12 s and 2.15 s later, close code 1005, `wasClean=true`,
 * with `target disconnected` logged BEFORE `client disconnected` by an instrumented gateway. Total
 * elapsed differed (47.2 s and 32.2 s); the ping COUNT did not. That is the overspeed rule and
 * nothing else.
 *
 * 27 exactly, not a rounder number, because 27 is the server's own comparison and a client that aims
 * at 30 already has only 3 s of margin.
 */
const PING_MIN_GAP_MS = 27000;

export class GameHandler extends Socket {

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

    /**
     * The keepalive interval handle, so it can be stopped. See `handleWorldLogin` for what leaving
     * it unheld cost. Per-instance, not static: two handlers must not share one timer.
     */
    this.pingTimer = null;

    /**
     * `performance.now()` of the last `CMSG_PING` actually put on the wire, or null while none has
     * been. Read by `ping()` against `PING_MIN_GAP_MS`; cleared with the connection, because the
     * server's overspeed counter is per SOCKET.
     */
    this.lastPingAt = null;

    /**
     * Whether the last ping was answered. PER INSTANCE.
     *
     * It was `static pingRecv = true` on the class, which no instance ever read: `this.pingRecv` on a
     * `GameHandler` does not see a static class field, so the first `ping()` of a session compared
     * `undefined === false` and the guard was dead until `handlePong` had written an instance field
     * of the same name. Declaring it here is the whole of the fix; a class-level default would also
     * have been shared by every handler, which is the same mistake `pingTimer` above records.
     */
    this.pingRecv = true;

    // A CONNECTION's state is not a HANDLER's state, and this handler is built once per
    // `GameSession` (session.ts:18) and outlives every socket it opens. See `resetConnection`.
    this.on('disconnect', () => this.resetConnection());

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
      // Also here, not only on the `disconnect` event. The reset must not depend on a close having
      // been delivered -- a socket that errored without closing, or a handler whose previous socket
      // was replaced by `Socket#dropSocket` (which deliberately silences it), would otherwise carry
      // the old connection's crypt into this handshake.
      this.resetConnection();
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
      // STOP, and do not also send. The old code disconnected and then fell through to build and
      // transmit a ping on the socket it had just closed -- `Socket#send` guards on `connected`,
      // which is still true until the close event lands, so the write really could go out. Stopping
      // the timer here as well as on the `disconnect` event covers the case where the socket was
      // already down and `disconnect()` therefore emits nothing.
      this.stopPing();
      this.disconnect();
      return;
    }

    // THE OVERSPEED FLOOR. See `PING_MIN_GAP_MS`: a ping less than 27 s after the previous one on this
    // socket increments the server's overspeed counter, and the third such ping ends the session. A
    // skipped ping costs nothing -- the timer fires again in 30 s and the server's own idle window is
    // far wider than that -- so refusing is strictly safer than sending.
    //
    // `pingRecv` is deliberately NOT cleared on this path: no packet went out, so there is no pong to
    // wait for, and clearing it would make the NEXT tick read "the last ping went unanswered" and
    // disconnect us for the server's silence about a packet we never sent.
    const now = performance.now();
    if (this.lastPingAt !== null && now - this.lastPingAt < PING_MIN_GAP_MS) {
      console.warn(
        `ping suppressed: ${Math.round(now - this.lastPingAt)} ms since the last one, floor is`
        + ` ${PING_MIN_GAP_MS} ms -- see PING_MIN_GAP_MS.`,
      );
      return;
    }

    // HEADER_SIZE_OUTGOING + the real body, which is 8 bytes: two uint32s.
    //
    // It was `OPCODE_SIZE_INCOMING + 64` -- the INCOMING opcode width (2) against an OUTGOING packet
    // whose header is 6, for a 66-byte buffer of which 14 are written. `BasePacket` derives the
    // declared body length from the buffer, so the header announced 60 bytes and 52 of them were
    // uninitialised slack. This server tolerates it; the same defect has already been fixed on the
    // movement and chat packets, and it is fixed here for the same reason -- a length field that is
    // not the length is a trap for the next reader of the wire, not a working feature.
    const app = new GamePacket(GameOpcode.CMSG_PING, GamePacket.HEADER_SIZE_OUTGOING + 8);
    app.writeUnsignedInt(1);      // ping ( unknown value)
    app.writeUnsignedInt(10);     // latency, 10ms for now

    this.pingRecv = false;
    this.lastPingAt = now;

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
    // THE EXPANSION BYTE, before the result branch consumes anything else: the body is
    // `code, u32, u8, u32, expansion` (measured -- see `account-info.ts`), and the UI needs the last
    // byte during the FrameXML load to know the level cap. Read off the raw bytes rather than through
    // the cursor so the branch below is untouched.
    readAuthResponseExpansion(new Uint8Array(gp.raw ?? []).subarray(gp.headerSize));

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
    // KEPT, so it can be stopped. This interval was started and never cleared: every world login
    // added another one, and they outlived the session -- a relog left the previous session's timer
    // still calling `ping()` on a disconnected handler, and `ping()` calls `disconnect()` when a pong
    // did not arrive. Re-entering also stacked them, so the ping rate doubled per login.
    //
    // 30 s, not 50: that is the reference client's `CMSG_PING` cadence. The 50 s value put the
    // interval uncomfortably close to the world socket's idle window -- the same window that killed
    // the session at ~58 s until `SMSG_TIME_SYNC_REQ` was answered -- and a keepalive whose period is
    // most of the timeout it exists to prevent has no margin for a slow frame.
    //
    // The stop-and-rearm stays, and so does its hazard, stated rather than guarded against here: this
    // restarts the ping PHASE from zero, so a second arrival on the same socket could put the next
    // ping less than 27 s after the last one and walk into the overspeed kick `PING_MIN_GAP_MS`
    // documents. `ping()`'s floor is what makes that safe, which is the right place for it -- the
    // floor is the rule the server actually measures, and it holds however the timer is armed.
    //
    // Whether a second `SMSG_LOGIN_VERIFY_WORLD` can even reach one socket was CHECKED and is not
    // established: the reference decodes it as the initial-login map announcement only
    // (`benilla-protocol/src/events/decode.rs:540-547`, `needs_ack: false`) and routes a cross-map
    // transfer through `SMSG_NEW_WORLD` instead. So there is no known path, and no guard is added for
    // one that has not been shown to exist.
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.ping();
    }, PING_INTERVAL_MS);

    this.joinWorldChannel();
    this.emit('join');
  }

  /**
   * Drop everything that belonged to the connection that just ended. Idempotent.
   *
   * `_crypt` is the one that breaks the NEXT login outright, and it is not a key -- it is a pair of
   * live RC4 KEYSTREAMS. `Crypt`'s `set key` (crypto/crypt.js:35-56) builds both from the session
   * key and then advances each by 1024 bytes, and every header encrypted or decrypted afterwards
   * advances them further, so a `Crypt` carries a POSITION, not just a secret.
   *
   * `SMSG_AUTH_CHALLENGE` -- the first packet of the next connection -- arrives in PLAINTEXT, but
   * `dataReceived` decrypts an incoming header whenever `_crypt` is truthy (line 126). A retained
   * crypt therefore XORs the new connection's first header against wherever the previous
   * connection's stream had got to. The 2-byte big-endian size that falls out is garbage,
   * `remaining` is set from it, and the framing loop never resynchronises: the second connection
   * cannot parse a single packet, so the handshake is never answered and every promise waiting on
   * one hangs. Measured on a live page: `_crypt` still set after `disconnect()` and still set on the
   * next login attempt.
   *
   * `authenticated` and `remaining` go with it for the same reason -- both describe a socket, and
   * `remaining` in particular is a half-read packet length from a stream that no longer exists.
   */
  resetConnection() {
    this.stopPing();
    // The server's overspeed counter is per SOCKET (`WorldSocket::m_LastPingTime`), so a new
    // connection starts with a clean one and must not inherit this one's last-ping stamp -- a
    // reconnect within 27 s of the previous ping would otherwise have its FIRST ping suppressed.
    this.lastPingAt = null;
    this.pingRecv = true;
    this._crypt = null;
    this.authenticated = false;
    this.remaining = false;
    // The units the ended session streamed in. Guid-keyed and never otherwise emptied -- see
    // `World#clearRemoteEntities`. Guarded because `World` is constructed at the end of this
    // constructor, after the `disconnect` subscription above is registered.
    if (this.world) {
      this.world.clearRemoteEntities();
    }
  }

  /** Stop the keepalive. Idempotent, and safe before the first login. */
  stopPing() {
    if (this.pingTimer !== null && this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
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
