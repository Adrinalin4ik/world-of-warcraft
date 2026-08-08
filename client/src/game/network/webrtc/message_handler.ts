import Webrtc from ".";
import World from "../../world";
import { EntityHandler } from "../entity/entity";
import { MessageType } from "./types";

export class MessageHandler {
  public static subscribers: Map<MessageType, Function[]> = new Map();

  constructor(private webrtc: Webrtc, private world: World) {
    new EntityHandler(this, this.world)
  }

  static handle(msg: string) {
    const parsed = JSON.parse(msg);
    MessageHandler.subscribers.get(parsed.type)?.forEach(fn => fn(parsed.peerId, parsed.data))
  }


  static subscribe(type: MessageType, callback: Function) {
    const subs = MessageHandler.subscribers.get(type);
    if (subs) {
      subs.push(callback);
    } else {
      MessageHandler.subscribers.set(type, [callback])
    }
  }

  sendMessage(type: MessageType, data: any) {
    const message = { peerId: this.webrtc.peerId, type, data }
    this.webrtc.sendMessage(JSON.stringify(message))
  }
}