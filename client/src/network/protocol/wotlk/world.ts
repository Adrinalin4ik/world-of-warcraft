/**
 * The 3.3.5 world transport: the character roster, create, delete, and entering the world.
 *
 * It DRIVES the existing `network/game/handler.js` through a narrow seam rather than replacing it.
 * That handler owns the socket, the RC4 header crypt, the packet framing and every in-world gameplay
 * handler on the same connection; moving the handshake out of it would risk the working world path
 * for nothing spec 3 needs. What spec 3 needs is this typed surface.
 */
import GameOpcode from '../../game/opcode';
import GamePacket from '../../game/packet';
import { ProxyConfig, resolveRealmEndpoint } from '../endpoint';
import { isWorldSuccess, worldRefusal } from '../stages';
import {
  CharacterRecord,
  CharCreateRequest,
  ProtocolRefusalError,
  RealmInfo,
  WorldTransport,
} from '../types';
import {
  CHAR_RESULT,
  charCreateRefusal,
  charDeleteRefusal,
  decodeCharEnum,
  decodeResultByte,
  encodeCharCreateBody,
  encodeGuidBody,
} from './world-wire';

export interface WorldPacketIo {
  /**
   * `account`/`sessionKey` are carried here (not read off some session the adapter happens to
   * hold) so the seam stays explicit: the world handshake needs them, and this is the one call
   * that starts it.
   */
  connect(host: string, port: number, realm: RealmInfo, account: string, sessionKey: Uint8Array): Promise<void>;
  send(opcode: number, body: Uint8Array): void;
  on(opcodeName: string, listener: (body: Uint8Array) => void): void;
  onDisconnect(listener: (reason: string) => void): void;
  close(): void;
}

type Pending<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

export class WotlkWorldTransport implements WorldTransport {
  private readonly io: WorldPacketIo;
  private readonly proxy: ProxyConfig;

  private join_: Pending<void> | null = null;
  private roster: Pending<CharacterRecord[]> | null = null;
  private create: Pending<void> | null = null;
  private remove: Pending<void> | null = null;
  private enter: Pending<void> | null = null;

  constructor(io: WorldPacketIo, proxy: ProxyConfig) {
    this.io = io;
    this.proxy = proxy;

    this.io.on('SMSG_AUTH_RESPONSE', (body) => {
      const code = decodeResultByte(body);
      if (isWorldSuccess(code)) {
        this.settle(this.join_, undefined);
      } else {
        this.fail(this.join_, new ProtocolRefusalError(worldRefusal(code)));
      }
      this.join_ = null;
    });

    this.io.on('SMSG_CHAR_ENUM', (body) => {
      this.settle(this.roster, decodeCharEnum(body));
      this.roster = null;
    });

    this.io.on('SMSG_CHAR_CREATE', (body) => {
      const code = decodeResultByte(body);
      if (code === CHAR_RESULT.CREATE_SUCCESS) {
        this.settle(this.create, undefined);
      } else {
        this.fail(this.create, new ProtocolRefusalError(charCreateRefusal(code)));
      }
      this.create = null;
    });

    this.io.on('SMSG_CHAR_DELETE', (body) => {
      const code = decodeResultByte(body);
      if (code === CHAR_RESULT.DELETE_SUCCESS) {
        this.settle(this.remove, undefined);
      } else {
        this.fail(this.remove, new ProtocolRefusalError(charDeleteRefusal(code)));
      }
      this.remove = null;
    });

    this.io.on('SMSG_LOGIN_VERIFY_WORLD', () => {
      this.settle(this.enter, undefined);
      this.enter = null;
    });

    // A dropped connection is the common failure, and it is exactly when a screen is waiting on
    // one of these promises. Without this, a caller awaiting a roster (or a join, or...) when the
    // socket drops would wait forever -- `close()` below handles the deliberate case, this handles
    // the involuntary one.
    this.io.onDisconnect((reason) => {
      this.abortAll(new Error(`world transport disconnected: ${reason}`));
    });
  }

  join(realm: RealmInfo, account: string, sessionKey: Uint8Array): Promise<void> {
    if (this.join_) {
      return Promise.reject(new Error('join() is already in progress on this transport'));
    }

    // Claimed synchronously, before anything async: `connect()` below is a whole handshake, not a
    // microtask, so a second call in the same turn must not slip past the guard above and race to
    // overwrite this slot.
    return new Promise<void>((resolve, reject) => {
      this.join_ = { resolve, reject };
      // Through the endpoint policy, never the realm's advertised address: from a browser the game
      // server is reachable only via the websockify proxy (`endpoint.ts` explains why). `account`
      // and `sessionKey` go through to the IO too -- the handshake needs both, and the existing
      // handler has no way to get them except through this call (see `createGameHandlerIo`).
      const endpoint = resolveRealmEndpoint(realm, this.proxy);
      this.io.connect(endpoint.host, endpoint.port, realm, account, sessionKey).catch(reject);
    });
  }

  characters(): Promise<CharacterRecord[]> {
    if (this.roster) {
      return Promise.reject(new Error('characters() is already in progress on this transport'));
    }

    return new Promise<CharacterRecord[]>((resolve, reject) => {
      this.roster = { resolve, reject };
      this.io.send(GameOpcode.CMSG_CHAR_ENUM, new Uint8Array(0));
    });
  }

  createCharacter(request: CharCreateRequest): Promise<void> {
    if (this.create) {
      return Promise.reject(new Error('createCharacter() is already in progress on this transport'));
    }

    return new Promise<void>((resolve, reject) => {
      this.create = { resolve, reject };
      this.io.send(GameOpcode.CMSG_CHAR_CREATE, encodeCharCreateBody(request));
    });
  }

  deleteCharacter(guid: string): Promise<void> {
    if (this.remove) {
      return Promise.reject(new Error('deleteCharacter() is already in progress on this transport'));
    }

    return new Promise<void>((resolve, reject) => {
      this.remove = { resolve, reject };
      this.io.send(GameOpcode.CMSG_CHAR_DELETE, encodeGuidBody(guid));
    });
  }

  enterWorld(guid: string): Promise<void> {
    if (this.enter) {
      return Promise.reject(new Error('enterWorld() is already in progress on this transport'));
    }

    return new Promise<void>((resolve, reject) => {
      this.enter = { resolve, reject };
      this.io.send(GameOpcode.CMSG_PLAYER_LOGIN, encodeGuidBody(guid));
    });
  }

  close(): void {
    // A caller awaiting any of these deserves to learn it will never arrive, rather than hang
    // forever on a promise nothing will settle now that the IO is going away.
    this.abortAll(new Error('world transport closed'));
    this.io.close();
  }

  onDisconnect(listener: (reason: string) => void): void {
    this.io.onDisconnect(listener);
  }

  private settle<T>(pending: Pending<T> | null, value: T): void {
    pending?.resolve(value);
  }

  private fail<T>(pending: Pending<T> | null, error: Error): void {
    pending?.reject(error);
  }

  private abortAll(error: Error): void {
    this.fail(this.join_, error);
    this.join_ = null;
    this.fail(this.roster, error);
    this.roster = null;
    this.fail(this.create, error);
    this.create = null;
    this.fail(this.remove, error);
    this.remove = null;
    this.fail(this.enter, error);
    this.enter = null;
  }
}

/**
 * The slice of `GameHandler` this adapter actually drives -- including the `session.auth` corner
 * the handshake reads its account/key from. `account` is a plain field (`AuthHandler` assigns it
 * directly), but `key` is a GETTER with no setter (`get key() { return this.srp && this.srp.K; }`);
 * this adapter cannot assign it, only the `srp` stand-in it reads from -- see `connect()` below.
 */
interface GameHandlerLike {
  connect(host: string, realm: RealmInfo): void;
  send(packet: GamePacket): void;
  disconnect(): void;
  on(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
  session: {
    auth: {
      account: string;
      srp: { K: number[] } | null;
    };
  };
}

/**
 * Adapts the existing `GameHandler` to `WorldPacketIo`. The handler stays exactly as it is -- this
 * is the whole of the coupling, and it is deliberately this small.
 */
export function createGameHandlerIo(handler: GameHandlerLike): WorldPacketIo {
  return {
    connect(host: string, port: number, realm: RealmInfo, account: string, sessionKey: Uint8Array) {
      return new Promise<void>((resolve, reject) => {
        // `handleAuthChallenge` (game/handler.js:204-243) builds CMSG_AUTH_SESSION from
        // `this.session.auth.account` and feeds `this.session.auth.key` into both the SHA1 digest
        // and the RC4 crypt seed -- fields the OLD `AuthHandler`'s own SRP exchange used to
        // populate. `WotlkLogonTransport` keeps its account and SRP state in its own private
        // fields and never touches that object, so without this, `.account` is null and the
        // handler throws on `.length` (handler.js:222) before the handshake is even sent, and
        // `join()`'s promise never settles. Setting them here, right before `connect()`, is the
        // seam: `game/handler.js` stays completely unedited.
        //
        // `account` must be upper-cased: the SRP proof the server already accepted was computed
        // against the upper-cased form (both `AuthHandler.authenticate` and `WotlkLogonTransport`
        // upper-case internally before sending), and `handleAuthChallenge`'s SHA1 digest must
        // match it exactly.
        handler.session.auth.account = account.toUpperCase();

        // `AuthHandler.key` has no setter -- it is `get key() { return this.srp && this.srp.K; }`
        // (network/auth/handler.js). Rather than edit that class, hand it a minimal stand-in
        // object carrying just the `K` the getter reads. `srp.K` has always been a plain
        // `number[]` (crypto/srp.js builds it with `this._K = []`), so `sessionKey` -- the
        // `Uint8Array` the protocol layer carries -- is converted here to match. (Both actual
        // consumers, `Hash#feed` -> `ByteBuffer#write` and the HMAC's `ba2binb`, would in fact
        // accept the `Uint8Array` directly -- neither calls `.concat` on it -- but matching the
        // shape everything else in this handler has always seen costs nothing and removes any
        // doubt.)
        handler.session.auth.srp = { K: Array.from(sessionKey) };

        // Resolve on the socket actually connecting -- NOT on the handshake verdict. The handler's
        // own `handleAuthResponse` and this adapter's `SMSG_AUTH_RESPONSE` listener (registered by
        // `WotlkWorldTransport`, above) both react to the same packet; if this promise also raced
        // to settle off `authenticate`/`reject`, the join outcome would depend on which of two
        // listeners on the same event happens to be registered first. It no longer does: the packet
        // listener is the single source of truth for the handshake verdict, and this promise is only
        // about whether the WebSocket itself came up.
        handler.once('connect', () => resolve());
        handler.once('disconnect', () =>
          // Name the endpoint. A realm on a port no websockify process is listening on fails right
          // here, and the word "refused" on its own sends the reader looking in the wrong place.
          reject(new Error(`world handshake refused at ${host}:${port}`)),
        );
        // The handler takes (host, realm) and reads the port off the realm, so it must be handed the
        // POLICY's host and port -- not the realm's advertised address.
        handler.connect(host, { ...realm, port });
      });
    },
    send(opcode: number, body: Uint8Array) {
      const packet = new GamePacket(opcode, GamePacket.HEADER_SIZE_OUTGOING + body.length);
      if (body.length) {
        packet.write(Array.from(body));
      }
      handler.send(packet);
    },
    on(opcodeName: string, listener: (body: Uint8Array) => void) {
      handler.on(`packet:receive:${opcodeName}`, (packet: any) => {
        listener(new Uint8Array(packet.read(packet.available)));
      });
    },
    onDisconnect(listener: (reason: string) => void) {
      handler.on('disconnect', () => listener('socket closed'));
    },
    close() {
      handler.disconnect();
    },
  };
}
