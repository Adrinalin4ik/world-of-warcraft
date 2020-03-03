import World from "../world";
import Webrtc from './webrtc'
export default class Network {
  public webrtc: Webrtc;
  constructor(world: World) {
    this.webrtc = new Webrtc(world);
    // this.webrtc.connect();
  }
}