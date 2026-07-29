import { MovementType, AnimationPlaybackType } from "./entity.type";

export interface IMovement {
  position: number[];
  rotation: number[];
  type: MovementType;
}

export interface IAnimation {
  animationIndex: number;
  inrerrupt?: boolean;
  repetitions?: number;
  playbackType: AnimationPlaybackType;
}