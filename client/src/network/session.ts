import Player from "../game/classes/player";
import AuthHandler from "./auth/handler";
import CharacterHandler from "./characters/handler";
import { GameHandler } from "./game/handler";
import RealmsHandler from "./realms/handler";
import config from "./config";
import { applyRealmlistOverride, loadSettings } from "./protocol/connection-settings";
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
      // The logon DEFAULT, for a caller that names no endpoint. `ProtocolSession#login` is handed one
      // at submit time and that wins (`WotlkLogonTransport#authenticate`); this is what stands when
      // nothing does, and it has to agree with the address the login screen shows -- which is these
      // same settings, not `network/config`'s build-time value.
      const settings = applyRealmlistOverride(loadSettings(), window.location.search);

      this.protocol_ = new ProtocolSession(
        new WotlkLogonTransport(createSocketLogonIo(), {
          host: settings.logonHost,
          port: settings.logonPort,
          game: config.game,
          version: [config.majorVersion, config.minorVersion, config.patchVersion],
          build: config.build,
          platform: config.platform,
          os: config.os,
          locale: config.locale,
          timezone: config.timezone,
        }),
        // No proxy configuration: the world socket is opened at the gateway with the realm's own
        // advertised address named in the URL, so there is no host to substitute. See
        // `protocol/endpoint.ts` and `network/gateway.ts`.
        new WotlkWorldTransport(createGameHandlerIo(this.game)),
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