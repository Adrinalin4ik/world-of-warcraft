import React from 'react';
import * as THREE from 'three';

import {
  CAM_COLLISION_RADIUS, CameraControl, advanceZoom, applyZoomScroll, createCameraControl,
  createPendingClicks, runLookSession, seatCamera,
} from '../../../game/camera/rig';
import { headHeight } from '../../../game/camera/pivot';
import { collisionWorld } from '../../../game/collision/collision-world';
import { CollisionLayer } from '../../../game/collision/types';
import {
  CAPSULE_HEIGHT, CAPSULE_RADIUS, MOUSELOOK_PITCH_CLAMP, RUN_BACK_RATIO, RUN_SPEED,
  STATIONARY_CHASE_RATE, TURN_RATE, TURN_RATE_MOVING, capsuleHalfSegment,
} from '../../../game/movement/constants';
import { movementFrame } from '../../../game/movement/frame';
import Player from '../../../game/classes/player';

interface IProp {
  camera: THREE.PerspectiveCamera;
  player: Player;
}

/** Shortest signed angle, so a chase never takes the long way round. */
function wrapPi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Input adapter for the avatar and the third-person camera.
 *
 * Deliberately thin: it owns DOM listeners, pointer lock and key state, and nothing else. Every
 * decision about how the body moves lives in `game/movement`, and every decision about where the
 * camera sits lives in `game/camera` -- both as pure functions over a cast closure, which is what
 * lets them be tested with no world loaded.
 *
 * This replaces an OrbitControls derivative that orbited a target, had no collision, no look modes,
 * and rotated the character by the same delta it orbited the camera by.
 */
class Controls extends React.Component<IProp> {
  private element: HTMLElement = document.body;

  private unit: Player;

  private camera: THREE.PerspectiveCamera;

  private rig: CameraControl = createCameraControl();

  private pending = createPendingClicks();

  private buttons = { left: false, right: false };

  private prevButtons = { left: false, right: false };

  private motion = { dx: 0, dy: 0 };

  private scrollNotches = 0;

  private keys = new Set<string>();

  /** Edge-triggered: the swim breach fires once per PRESS, never on a held key. */
  private jumpPressed = false;

  constructor(props: IProp) {
    super(props);
    this.unit = props.player;
    this.camera = props.camera;

    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onContextMenu = this.onContextMenu.bind(this);
  }

  componentDidMount() {
    this.element.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    this.element.addEventListener('mousemove', this.onMouseMove);
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
  }

  componentWillUnmount() {
    this.element.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.element.removeEventListener('mousemove', this.onMouseMove);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
  }

  private onContextMenu(event: Event) {
    // Right-drag turns the character; the browser menu must not interrupt it.
    event.preventDefault();
  }

  private onMouseDown(event: MouseEvent) {
    if (event.button === 0) this.buttons.left = true;
    if (event.button === 2) this.buttons.right = true;
  }

  private onMouseUp(event: MouseEvent) {
    if (event.button === 0) this.buttons.left = false;
    if (event.button === 2) this.buttons.right = false;
    if (!this.buttons.left && !this.buttons.right && document.pointerLockElement) {
      document.exitPointerLock();
    }
  }

  private onMouseMove(event: MouseEvent) {
    if (!this.buttons.left && !this.buttons.right) {
      return;
    }
    // While pointer-locked, movementX/Y are the only meaningful deltas -- clientX/Y stop moving.
    this.motion.dx += event.movementX ?? 0;
    this.motion.dy += event.movementY ?? 0;
  }

  private onWheel(event: WheelEvent) {
    event.preventDefault();
    this.scrollNotches += event.deltaY > 0 ? -1 : 1;
  }

  private onKeyDown(event: KeyboardEvent) {
    const key = event.code;
    if (key === 'Space' && !this.keys.has(key)) {
      this.jumpPressed = true;
    }
    this.keys.add(key);
  }

  private onKeyUp(event: KeyboardEvent) {
    this.keys.delete(event.code);
  }

  private held(...codes: string[]): boolean {
    return codes.some((code) => this.keys.has(code));
  }

  /** True when translating -- the turn rate drops while moving. */
  private isTranslating(forward: number, strafe: number): boolean {
    return forward !== 0 || strafe !== 0;
  }

  public update(delta: number) {
    const player = this.unit;
    const now = performance.now() / 1000;

    // 1. Mouse look. Right-drag turns the character, left-drag orbits, both buttons run forward.
    const look = runLookSession(this.rig, this.buttons, this.motion, this.prevButtons, this.pending);
    this.motion.dx = 0;
    this.motion.dy = 0;
    this.prevButtons = { ...this.buttons };

    if (this.rig.look && !document.pointerLockElement) {
      this.element.requestPointerLock?.();
    }

    if (look.turnsCharacter) {
      player.move.faceYaw += look.yawDelta;
    }

    // While swimming, mouselook is a DIRECT set of the swim pitch from the camera aim -- no
    // integrator and no rate limit, which is what makes aiming up and swimming forward feel
    // immediate. A left-drag orbit steers nothing, so it must not bend the swim.
    if (player.move.swimming && this.rig.look === 'right') {
      player.move.swimPitch = Math.max(
        -MOUSELOOK_PITCH_CLAMP, Math.min(MOUSELOOK_PITCH_CLAMP, this.rig.pitch),
      );
    }

    // 2. Zoom.
    if (this.scrollNotches !== 0) {
      applyZoomScroll(this.rig, this.scrollNotches);
      this.scrollNotches = 0;
    }
    advanceZoom(this.rig, delta);

    // 3. Keyboard. A/D TURN in vanilla rather than strafing; Q/E strafe.
    const forward = (this.held('KeyW', 'ArrowUp') || look.bothButtonsRun ? 1 : 0)
      - (this.held('KeyS', 'ArrowDown') ? 1 : 0);
    const strafe = (this.held('KeyQ') ? 1 : 0) - (this.held('KeyE') ? 1 : 0);
    const turning = (this.held('KeyA', 'ArrowLeft') ? 1 : 0)
      - (this.held('KeyD', 'ArrowRight') ? 1 : 0);

    if (turning !== 0) {
      const rate = TURN_RATE * (this.isTranslating(forward, strafe) ? TURN_RATE_MOVING : 1);
      player.move.faceYaw += turning * rate * delta;
    }

    // 4. Movement direction, expressed in the facing basis.
    const yaw = player.move.faceYaw;
    const dir = new THREE.Vector3(
      Math.cos(yaw) * forward - Math.sin(yaw) * strafe,
      Math.sin(yaw) * forward + Math.cos(yaw) * strafe,
      0,
    );
    const moving = forward !== 0 || strafe !== 0;
    const speed = forward < 0 ? RUN_SPEED * RUN_BACK_RATIO : RUN_SPEED;

    // 5. One movement frame. The claim is outdoor-only for now; see the note in Task 22.
    const claim = { wmoGroup: null };
    const deps = {
      cast: collisionWorld.castFor(CollisionLayer.Walk, CAPSULE_RADIUS, capsuleHalfSegment()),
      surfaceAt: (feet: THREE.Vector3) => (
        collisionWorld.surfaceAt(feet.x, feet.y, claim)?.surfaceZ ?? null
      ),
    };

    movementFrame(player.move, deps, {
      moving, dir, speed, wantJump: this.jumpPressed, jumpPressed: this.jumpPressed,
    }, delta, now);
    this.jumpPressed = false;

    // 6. The rendered body heading. Moving without a strafe snaps to the aim; standing, it chases.
    if (moving && strafe === 0) {
      player.move.modelYaw = yaw;
    } else if (!moving) {
      const gap = wrapPi(yaw - player.move.modelYaw);
      const chase = Math.min(1, (STATIONARY_CHASE_RATE * TURN_RATE * delta) / Math.PI);
      player.move.modelYaw += gap * chase;
    }

    player.syncViewFromMove();

    // 7. Seat the camera. Its cast uses the CAMERA face set, not the walking one, so it stops at
    // overhangs the player walks under and threads railings the player stands on.
    const head = player.move.pos.clone();
    head.z += CAPSULE_HEIGHT - CAPSULE_RADIUS;

    const seat = seatCamera(this.rig, {
      feet: player.move.pos,
      head,
      pivotHeight: headHeight(null, 1),
      cast: collisionWorld.castFor(CollisionLayer.Camera, CAM_COLLISION_RADIUS, 0),
      dt: delta,
    });

    this.camera.position.copy(seat.position);
    this.camera.quaternion.copy(seat.quaternion);

    // 8. First person: hide the body once the fade reaches zero.
    if (player.model) {
      player.model.visible = this.rig.selfFadeAlpha > 0.01;
    }
  }

  render() {
    return <div className="controls" />;
  }
}

export default Controls;
