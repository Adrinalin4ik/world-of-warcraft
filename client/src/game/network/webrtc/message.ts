import { MessageType } from "./types";

export class Message {
  public type: MessageType = MessageType.none;
  constructor(type: MessageType) {
    this.type = type;
  }
}