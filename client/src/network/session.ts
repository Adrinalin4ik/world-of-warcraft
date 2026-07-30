import Player from "../game/classes/player";
import AuthHandler from "./auth/handler";
import CharacterHandler from "./characters/handler";
import { AuthorizationStatus, SocketConnestionStatus } from "./enums";
import { GameHandler } from "./game/handler";
import RealmsHandler from "./realms/handler";



export class GameSession {
  public player: Player = new Player('Player', "-1");
  public auth = new AuthHandler();
  public realms = new RealmsHandler(this);
  public game = new GameHandler(this);
  public characters = new CharacterHandler(this);
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

  async authenticate(username: string, password: string): Promise<{status: string}> {
    return new Promise((resolve, reject) => {
      this.auth.authenticate(username, password);

      const onAuthenticate = () => {
        this.auth.removeListener('authenticate', onAuthenticate);
        resolve({status: AuthorizationStatus.Success});
      }

      setTimeout(() => {
        reject({status: 'Timeout'});
      }, 5000);

      this.auth.on('authenticate', onAuthenticate);
    })
  }

  async connect(): Promise<{status: string}> {
    return new Promise((resolve, reject) => {
      this.auth.connect();

      const onConnect = () => {
        this.auth.removeListener('connect', onConnect);
        resolve({status: SocketConnestionStatus.Connected});
      }

      const onReject = () => {
        reject({status: 'Server reject the connection'});
        this.auth.removeListener('reject', onReject);
      }

      setTimeout(() => {
        reject({status: 'Timeout'});
      }, 5000);

      this.auth.on('connect', onConnect);
      this.auth.on('reject', onReject);
    })
  }
}