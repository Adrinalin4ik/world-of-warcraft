/**
 * The 3.3.5 logon transport: SRP6 against realmd, then the realm list, over one socket.
 *
 * IO is injected (`LogonIo`) rather than inherited, which is what lets the whole exchange be tested
 * with a fake that replies in bytes -- no WebSocket, no server, no login. The wire layouts are in
 * `logon-wire.ts`; SRP is the existing `crypto/srp.js`, untouched.
 */
import SRP from '../../crypto/srp';
import Socket from '../../net/socket';
import { isLogonSuccess, logonRefusal } from '../stages';
import { LogonEndpoint, LogonTransport, ProtocolRefusalError, RealmInfo } from '../types';
import {
  decodeLogonChallenge,
  decodeLogonProof,
  decodeRealmList,
  encodeLogonChallenge,
  encodeLogonProof,
  encodeRealmListRequest,
  LOGON_OPCODE,
} from './logon-wire';

export interface LogonIo {
  connect(host: string, port: number): Promise<void>;
  send(bytes: Uint8Array): void;
  onMessage(listener: (bytes: Uint8Array) => void): void;
  /**
   * The socket went away without the transport asking it to.
   *
   * This exists because its absence had a nasty shape: every path that ENDS an authentication --
   * success, refusal, a failed connect -- clears the promise slot, but a socket that simply dropped
   * mid-handshake reached none of them. The attempt then hung for ever, and because `authenticate`
   * refuses to start while a slot is held, EVERY later login threw "already in progress" instead of
   * dialing. One failed attempt poisoned the page: exactly the "second time it never loads even with
   * correct credentials" the owner reported.
   */
  onDisconnect(listener: () => void): void;
  close(): void;
}

export type LogonConfig = {
  host: string;
  port: number;
  game: string;
  version: [number, number, number];
  build: number;
  platform: string;
  os: string;
  locale: string;
  timezone: number;
};

/** The slice of `crypto/srp.js`'s `SRP` this transport actually drives. */
export interface SrpLike {
  feed(s: number[], B: number[], account: string, password: string): void;
  readonly A: { toArray(): number[] };
  readonly M1: { digest: number[] };
  readonly K: number[];
  validate(M2: number[]): boolean;
}

/**
 * Builds the SRP session for a challenge's `N`/`g`. Defaults to the real `SRP`; a test can inject
 * one that skips the arithmetic and returns fixed `A`/`M1`/`K`, which is the only way the
 * successful-handshake path (the one that only otherwise fails against a live server) is testable.
 */
export type SrpFactory = (N: number[], g: number[]) => SrpLike;

export class WotlkLogonTransport implements LogonTransport {
  private readonly io: LogonIo;
  private readonly config: LogonConfig;
  private readonly srpFactory: SrpFactory;

  private srp: SrpLike | null = null;
  private account = '';
  private password = '';
  private sessionKey: Uint8Array | null = null;

  private authResolve: ((value: { sessionKey: Uint8Array }) => void) | null = null;
  private authReject: ((error: Error) => void) | null = null;
  private realmsResolve: ((realms: RealmInfo[]) => void) | null = null;
  private realmsReject: ((error: Error) => void) | null = null;

  constructor(
    io: LogonIo,
    config: LogonConfig,
    srpFactory: SrpFactory = (N, g) => new SRP(N, g),
  ) {
    this.io = io;
    this.config = config;
    this.srpFactory = srpFactory;
    this.io.onMessage((bytes) => this.receive(bytes));
    // The socket dropping is a terminal outcome for whatever was in flight, and until this existed it
    // was the ONE terminal outcome nothing observed -- see `LogonIo#onDisconnect`.
    this.io.onDisconnect(() => this.settleInFlight(new Error('logon socket closed')));
  }

  /**
   * Reject anything awaiting this transport and release the slots.
   *
   * Separate from `close()` because a socket that dropped on its own has already gone: calling
   * `io.close()` from inside its own disconnect notification would be circular. `close()` is this plus
   * closing the IO.
   */
  private settleInFlight(error: Error): void {
    this.authReject?.(error);
    this.authResolve = null;
    this.authReject = null;
    this.realmsReject?.(error);
    this.realmsResolve = null;
    this.realmsReject = null;
  }

  async authenticate(
    account: string,
    password: string,
    endpoint?: LogonEndpoint,
  ): Promise<{ sessionKey: Uint8Array }> {
    if (this.authResolve) {
      throw new Error('authenticate() is already in progress on this transport');
    }

    // Claimed synchronously, before anything async: with the real IO, `connect()` is a whole
    // WebSocket handshake, not a microtask, so two calls issued in the same turn must not both
    // slip past the guard above and race to overwrite this slot -- only one may ever hold it.
    const settled = new Promise<{ sessionKey: Uint8Array }>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
    });

    this.account = account.toUpperCase();
    this.password = password.toUpperCase();

    try {
      // The caller's endpoint wins, and `network/config`'s baked value is only the DEFAULT: this is
      // what makes the login screen's server-address field (and `?realmlist=`) actually dial.
      await this.io.connect(
        endpoint?.host ?? this.config.host,
        endpoint?.port ?? this.config.port,
      );
    } catch (error) {
      // A failed connect must leave the transport able to try again, not stuck holding a slot no
      // call will ever finish.
      this.authResolve = null;
      this.authReject = null;
      throw error;
    }

    this.io.send(
      encodeLogonChallenge({
        account: this.account,
        game: this.config.game,
        version: this.config.version,
        build: this.config.build,
        platform: this.config.platform,
        os: this.config.os,
        locale: this.config.locale,
        timezone: this.config.timezone,
      }),
    );

    return settled;
  }

  async realms(): Promise<RealmInfo[]> {
    if (!this.sessionKey) {
      throw new Error('cannot list realms before authenticate() resolves');
    }
    if (this.realmsResolve) {
      throw new Error('realms() is already in progress on this transport');
    }

    const settled = new Promise<RealmInfo[]>((resolve, reject) => {
      this.realmsResolve = resolve;
      this.realmsReject = reject;
    });

    this.io.send(encodeRealmListRequest());
    return settled;
  }

  close(): void {
    // A caller awaiting a login or a realm list deserves to learn it will never arrive, rather
    // than hang forever on a promise nothing will ever settle now that the IO is going away.
    this.settleInFlight(new Error('logon transport closed'));
    this.io.close();
  }

  private receive(bytes: Uint8Array): void {
    switch (bytes[0]) {
      case LOGON_OPCODE.CHALLENGE:
        this.onChallenge(bytes);
        break;
      case LOGON_OPCODE.PROOF:
        this.onProof(bytes);
        break;
      case LOGON_OPCODE.REALM_LIST:
        this.realmsResolve?.(decodeRealmList(bytes));
        this.realmsResolve = null;
        this.realmsReject = null;
        break;
      default:
        break;
    }
  }

  private onChallenge(bytes: Uint8Array): void {
    const challenge = decodeLogonChallenge(bytes);

    if (!isLogonSuccess(challenge.code)) {
      this.failAuth(challenge.code);
      return;
    }

    this.srp = this.srpFactory(Array.from(challenge.N!), Array.from(challenge.g!));
    this.srp.feed(
      Array.from(challenge.salt!),
      Array.from(challenge.B!),
      this.account,
      this.password,
    );

    this.io.send(
      encodeLogonProof({
        A: new Uint8Array(this.srp.A.toArray()),
        M1: new Uint8Array(this.srp.M1.digest),
      }),
    );
  }

  private onProof(bytes: Uint8Array): void {
    const proof = decodeLogonProof(bytes);

    if (!isLogonSuccess(proof.code)) {
      this.failAuth(proof.code);
      return;
    }

    if (!this.srp?.validate(Array.from(proof.M2!))) {
      // A server that answers with a proof we cannot verify is not our server.
      this.failAuth(0x0f);
      return;
    }

    this.sessionKey = new Uint8Array(this.srp.K);
    this.authResolve?.({ sessionKey: this.sessionKey });
    this.authResolve = null;
    this.authReject = null;
  }

  private failAuth(code: number): void {
    const error = new ProtocolRefusalError(logonRefusal(code));
    // Credentials are cleared here, not by the caller: a refusal must never be resubmitted (an
    // 0x05 locks the account out), and leaving them in memory invites exactly that.
    this.account = '';
    this.password = '';
    this.srp = null;
    this.authReject?.(error);
    this.authResolve = null;
    this.authReject = null;
  }
}

/**
 * The production IO: the existing `net/socket.js`. That socket is a raw byte accumulator with no
 * packet concept of its own -- framing has always been the consumer's job. This adapter hands over
 * whatever arrived on `data:receive`, exactly what `network/auth/handler.js` has always done
 * (`AuthPacket.HEADER_SIZE` is 1, and it reads the rest of the buffer as a single packet). realmd's
 * packets are small and arrive one per message in practice, but a split or coalesced arrival is a
 * known limitation shared with the existing client, not something this adapter solves. Takes the
 * socket as an optional argument (defaulting to a real one), the same seam the SRP factory used to
 * make the successful-handshake path testable -- this is the only way `onMessage`'s framing is
 * testable without a WebSocket.
 */
export function createSocketLogonIo(socket: Socket = new Socket()): LogonIo {
  return {
    connect(host: string, port: number) {
      // Every attempt dials FRESH. A logon socket left open from a previous attempt is the other half
      // of the poisoned-page bug described on `onDisconnect`: `Socket#connect` will reconnect an open
      // socket now, but the realmd handshake is stateful (SRP6 B, salt and the account it was started
      // for all live on the transport), so continuing on a connection that already carries a half-run
      // handshake is not something the server has any reason to accept.
      if (socket.connected) {
        socket.disconnect();
      }
      return new Promise<void>((resolve, reject) => {
        // Named, and removed on the way out. `once` leaves the loser of the race registered: the
        // `disconnect` listener of a SUCCESSFUL connect stayed live for the socket's whole life,
        // accumulating one dead listener per attempt and calling `reject` on a settled promise.
        const onConnect = () => {
          socket.removeListener('disconnect', onFail);
          resolve();
        };
        const onFail = () => {
          socket.removeListener('connect', onConnect);
          reject(new Error('logon socket closed'));
        };
        socket.once('connect', onConnect);
        socket.once('disconnect', onFail);
        socket.connect(host, port);
      });
    },
    send(bytes: Uint8Array) {
      socket.socket.send(bytes);
    },
    onDisconnect(listener: () => void) {
      socket.on('disconnect', () => listener());
    },
    onMessage(listener: (bytes: Uint8Array) => void) {
      socket.on('data:receive', () => {
        // `read()` returns a NEW ByteBuffer wrapping the slice, not the raw bytes -- the naming
        // invites reading `new Uint8Array(slice)`, which silently yields a zero-length array
        // because a ByteBuffer isn't array-like. The slice's own `.buffer` is the actual bytes.
        const slice = socket.buffer.read(socket.buffer.available);
        listener(new Uint8Array(slice.buffer));
      });
    },
    close() {
      socket.disconnect();
    },
  };
}
