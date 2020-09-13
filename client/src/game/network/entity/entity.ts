import World from "../../world";
import { MessageType } from "../webrtc/types";
import { MessageHandler } from "../webrtc/message_handler";
import { IMovement, IAnimation } from "./entity.interface";
import { MovementType, AnimationPlaybackType } from "./entity.type";

export class EntityHandler {
  constructor(
    private messageHandler: MessageHandler,
    private world: World) {

    this.world.player.on('animation:play', (animationIndex, inrerrupt, repetitions) => {
      const animationMessage: IAnimation = {
        animationIndex,
        inrerrupt,
        repetitions,
        playbackType: AnimationPlaybackType.start
      };

      this.messageHandler.sendMessage(MessageType.animation, animationMessage)
    })
    this.world.player.on('animation:stop', (animationIndex: number) => {
      const animationMessage: IAnimation = {
        animationIndex,
        playbackType: AnimationPlaybackType.stop
      };
      this.messageHandler.sendMessage(MessageType.animation, animationMessage)
    })

    this.world.player.on('position:change', (pos: THREE.Vector3, rot: THREE.Euler) => {
      // const movementMessage: IMovement = {
      //   position: [pos.x, pos.y, pos.z],
      //   rotation: [rot.x, rot.y, rot.z],
      //   type: MovementType.forward
      // }
      // this.messageHandler.sendMessage(MessageType.movement, movementMessage)
    })

    MessageHandler.subscribe(MessageType.movement, (peerId: string, data: IMovement) => {
      const entity = this.world.entities.get(peerId);
      if (!entity) return;
      entity.position.set(data.position[0], data.position[1], data.position[2])
      entity.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2])
    })

    MessageHandler.subscribe(MessageType.animation, (peerId: string, data: IAnimation) => {
      const entity = this.world.entities.get(peerId);
      if (!entity) return;
      switch (data.playbackType) {
        case AnimationPlaybackType.start:
          entity.setAnimation(data.animationIndex, data.inrerrupt, data.repetitions)
          break;
        case AnimationPlaybackType.stop:
          entity.stopAnimation(data.animationIndex);
          break;
      }
    })
  }
}