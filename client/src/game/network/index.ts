import World from "../world";
import Webrtc from './webrtc'
import { MessageHandler } from "./webrtc/message_handler";
export default class Network {
  public webrtc: Webrtc;
  public messageHandler: MessageHandler;

  constructor(world: World) {
    this.webrtc = new Webrtc(world);
    this.webrtc.connect();

    this.messageHandler = new MessageHandler(this.webrtc, world)
  }
}