import Player from "../game/classes/player";
import AuthHandler from "./auth/handler";
import CharacterHandler from "./characters/handler";
import { GameHandler } from "./game/handler";
import RealmsHandler from "./realms/handler";
import config from "./config";
import { ProtocolSession } from "./protocol/session";
import { createSocketLogonIo, WotlkLogonTransport } from "./protocol/wotlk/logon";
import { createGameHandlerIo, WotlkWorldTransport } from "./protocol/wotlk/world";



export class GameSession {
  public player: Player = new Player('Player', "-1");
  public auth = new AuthHandler();
  public realms = new RealmsHandler(this);
  public game = new GameHandler(this);
  public characters = new CharacterHandler(this);
  private protocol_: ProtocolSession | null = null;

  /**
   * The typed pre-world session. Built on first read, and building it opens nothing -- the transports
   * connect only when `login()` is called. The legacy handlers above stay exactly where they are
   * until spec 3's screens replace them.
   */
  get protocol(): ProtocolSession {
    if (!this.protocol_) {
      this.protocol_ = new ProtocolSession(
        new WotlkLogonTransport(createSocketLogonIo(), {
          host: config.serverhost,
          port: Number(config.authport),
          game: config.game,
          version: [config.majorVersion, config.minorVersion, config.patchVersion],
          build: config.build,
          platform: config.platform,
          os: config.os,
          locale: config.locale,
          timezone: config.timezone,
        }),
        new WotlkWorldTransport(createGameHandlerIo(this.game), {
          // The websockify proxies listen on the host the app was served from; the realm's own
          // advertised address has no WebSocket listener. See `protocol/endpoint.ts`.
          proxyHost: config.serverhost,
          rewriteRealmHost: true,
        }),
      );
    }
    return this.protocol_;
  }
  // Set by `offline-session.ts` for the networking-free `/game?offline=1` debug route. A session
  // that never calls `auth.connect()`/`game.connect()` -- declared here (not bolted on with `as
  // any`) so the next caller that reaches for a session sees the flag and can't accidentally wire
  // one up to the network.
  public offline?: boolean;
  public offlineSpot?: string;
  // public auth = {
  //   host: '',
  //   authenticate(username: string, password: string) {},
  //   removeListener(a: any, b: any) {},
  //   connect() {},
  //   on(a: any, b:any) {},
  // };
  
  // public realms = {
  //   list: [],
  //   refresh() {},
  //   on(a: any, b:any) {},
  // };
  // // game = {
  // //   connect(a: any, b:any) {},
  // //   on(a: any, b:any) {}
  // // }
  // public characters = {
  //   list: [],
  //   refresh() {},
  //   removeListener(a: any, b: any) {},
  //   on(a: any, b:any) {}
  // };

  constructor() {
    (window as any).session = this;
  }

  // `authenticate()` and `connect()` used to live here for the retired React login/realm/character
  // routes. They were the only remaining way to put a real `SRP` on the same `AuthHandler` that the
  // world handshake writes its stand-in onto (`protocol/wotlk/world.ts`), and nothing called them once
  // those routes went. Deleted with the screens they served; the glue screens use `protocol` above.
}