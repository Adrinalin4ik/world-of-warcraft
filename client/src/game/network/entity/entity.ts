import * as THREE from "three";
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
      const movementMessage: IMovement = {
        position: [pos.x, pos.y, pos.z],
        rotation: [rot.x, rot.y, rot.z],
        type: MovementType.forward
      }
      this.messageHandler.sendMessage(MessageType.movement, movementMessage)
    })

    MessageHandler.subscribe(MessageType.movement, (peerId: string, data: IMovement) => {
      const entity = this.world.entities.get(peerId);
      if (!entity) return;

      // This peer's motion arrives in discrete messages, so its position advances at MESSAGE
      // cadence, not frame cadence. `Unit#updateLocomotion` differences that position every frame
      // and would read the gaps as standing and the catch-ups as teleports, flip-flopping the gait
      // and pinning the animation cursor. The wire carries the peer's real gait anyway. See
      // `Unit#wireDriven`.
      entity.wireDriven = true;

      entity.position.set(data.position[0], data.position[1], data.position[2])
      entity.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2])
    })

    MessageHandler.subscribe(MessageType.animation, (peerId: string, data: IAnimation) => {
      const entity = this.world.entities.get(peerId);
      if (!entity) return;

      // Same reason, from the other side: this peer's animation is chosen remotely, so the local
      // gait pick must not compete with it. See `Unit#wireDriven`.
      entity.wireDriven = true;

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