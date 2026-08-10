import { beginSection, endSection } from '../../../game/perf/anim-section';
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
  SETTLE_STREAM_TIMEOUT, SETTLE_TIMEOUT, STATIONARY_CHASE_RATE, TURN_RATE, TURN_RATE_MOVING,
  capsuleHalfSegment,
} from '../../../game/movement/constants';
import { movementFrame } from '../../../game/movement/frame';
import { streamMovement } from '../../../game/movement/outbound';
import { rescueFromVoid } from '../../../game/movement/void-rescue';
import Player from '../../../game/classes/player';

interface IProp {
  camera: THREE.PerspectiveCamera;
  player: Player;
  /**
   * A clean left click on the world -- a press and release that never dragged past the orbit
   * threshold. The argument is normalised device coordinates (x, y in [-1, 1], y UP).
   *
   * `runLookSession` has produced `leftClick` since the camera rig was written and NOTHING HAS EVER
   * READ IT: its own doc says "a left click selects a target instead", and this is that caller. The
   * classification is left where it was rather than reimplemented here, so the click-versus-drag rule
   * and the both-buttons cancellation stay in one place.
   */
  onWorldClick?: (ndc: { x: number; y: number }) => void;
  /**
   * A clean right click on the world -- the CONTEXT ACTION, which for a hostile unit is "attack"
   * (`benilla/src/target/click.rs`: "a clean right-click dispatches the context action (attack, NPC
   * interact, ...)"). Same NDC convention as `onWorldClick`.
   */
  onWorldRightClick?: (ndc: { x: number; y: number }) => void;
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

  /** The last un-locked cursor position, in client pixels. See `onMouseMove` for why it is tracked. */
  private pointer = { x: 0, y: 0 };

  private scrollNotches = 0;

  private keys = new Set<string>();

  /** Edge-triggered: the swim breach fires once per PRESS, never on a held key. */
  private jumpPressed = false;

  /** Pointer lock already asked for in this look session. See the request site for why. */
  private lockRequested = false;

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
    this.pointer.x = event.clientX;
    this.pointer.y = event.clientY;
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
    // BEFORE the early return. The pick needs where the cursor IS, and a click is by definition a
    // press that did not drag -- so the last position with no button held is the position that
    // matters. Reading it only while dragging would leave the pick using wherever the cursor was
    // when the last drag ended, which is a different unit.
    //
    // Not updated while pointer-locked: `clientX/Y` freeze during a lock and `movementX/Y` are the
    // only real deltas (see below), so the frozen value is the last true screen position and is what
    // the release should pick against.
    if (!document.pointerLockElement) {
      this.pointer.x = event.clientX;
      this.pointer.y = event.clientY;
    }
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

    // ONE request per look session, on the frame the drag starts -- not every frame it continues.
    //
    // `document.pointerLockElement` is not the guard it looks like: the lock is granted
    // asynchronously, so it stays null for the whole handshake and this fired again on every frame
    // in between. Chrome then rejects the burst outright with
    // `NotAllowedError: Too many pointer lock requests in a short window`, which is how a mouselook
    // drag lost its lock instead of gaining it. Latched on the look session, cleared when the drag
    // ends, so a genuine denial is not retried at frame rate either.
    if (this.rig.look) {
      if (!this.lockRequested && !document.pointerLockElement) {
        this.lockRequested = true;
        // Newer Chrome returns a promise here and older ones return undefined; an unhandled
        // rejection was reported as "a promise was rejected with a non-error" either way.
        Promise.resolve(this.element.requestPointerLock?.()).catch(() => undefined);
      }
    } else {
      this.lockRequested = false;
    }

    if (look.turnsCharacter) {
      player.move.faceYaw += look.yawDelta;
    }

    // THE TARGET SELECT. `leftClick` is a press and release that never dragged, which is exactly the
    // gesture the reference routes to selection (`benilla/src/target/click.rs#select_on_click`, "a
    // clean left-click selects the hovered unit ... never a drag").
    //
    // NDC from the CLIENT RECT of the look element, not from `window.innerWidth`: the two agree
    // today because the canvas is fullscreen, and silently would not if it ever were not. y is
    // flipped -- `clientY` grows downward and NDC y grows up.
    if ((look.leftClick || look.rightClick) && (this.props.onWorldClick || this.props.onWorldRightClick)) {
      const bounds = this.element.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        const ndc = {
          x: ((this.pointer.x - bounds.left) / bounds.width) * 2 - 1,
          y: -(((this.pointer.y - bounds.top) / bounds.height) * 2 - 1),
        };
        if (look.leftClick) this.props.onWorldClick?.(ndc);
        if (look.rightClick) this.props.onWorldRightClick?.(ndc);
      }
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

    // Release the post-teleport settle hold once the destination's collision has actually arrived.
    //
    // The hold exists because streamed collision lands several frames after the snap, and gravity
    // would drop the avatar through a city that has not loaded. Releasing on GROUND CONTACT is the
    // trap: a teleport into open air, or onto water, never produces contact and would hang forever.
    //
    // THREE releases, not two, and the middle one is the world-entry fix. A plain `SETTLE_TIMEOUT`
    // release dropped the avatar through Elwynn whenever the ADT under the spawn had not registered
    // within six seconds -- measured on a live entry with the terrain fetches delayed, and the fall
    // is unrecoverable once the body is below the surface. So the six-second release now also
    // requires the terrain under our own XY to be REGISTERED: with ground loaded and still no floor
    // under the capsule we genuinely are over a hole or a cliff, and falling is right. See
    // `SETTLE_STREAM_TIMEOUT` for the cap that keeps the wait from ever becoming a hang.
    if (player.move.settling) {
      const feetCentre = player.move.pos.clone();
      feetCentre.z += CAPSULE_HEIGHT * 0.5;
      const resident = deps.cast(feetCentre, new THREE.Vector3(0, 0, -1), 200) !== null;
      const groundStreamed = collisionWorld.terrain
        .heightAt(player.move.pos.x, player.move.pos.y) !== null;
      // How long we have been holding, reconstructed from the deadline. `PlayerMoveState` carries a
      // deadline rather than a start, and every writer of it (`Unit#teleportTo`, and the rescue
      // below) arms it at `now + SETTLE_TIMEOUT` -- so this subtraction is exact, and it is the ONE
      // thing that couples the two timeouts. A writer using a different offset would have to say so
      // here.
      const elapsed = now - (player.move.settleDeadline - SETTLE_TIMEOUT);

      if (resident
        || (groundStreamed && elapsed >= SETTLE_TIMEOUT)
        || elapsed >= SETTLE_STREAM_TIMEOUT) {
        player.move.settling = false;
      }
    }

    beginSection('ctl.move');
    movementFrame(player.move, deps, {
      moving, dir, speed, wantJump: this.jumpPressed, jumpPressed: this.jumpPressed,
    }, delta, now);
    endSection('ctl.move');
    this.jumpPressed = false;

    // The other half of the same fix: a body that fell out of the world anyway is put back on it.
    // Nothing else can end that fall -- streaming keeps working, the terrain loads, and the mover's
    // ground probe simply never reaches it from below. Re-arms the settle hold so the mover's own
    // election snap closes the last fraction of a yard onto the real collision triangle rather than
    // this rescue's interpolated heightmap height.
    if (rescueFromVoid(player.move, (x, y) => collisionWorld.terrain.heightAt(x, y))) {
      player.move.settling = true;
      player.move.settleDeadline = now + SETTLE_TIMEOUT;
      console.warn('movement: fell out of the world, replaced on the terrain at', player.move.pos);
    }

    // 6. The rendered body heading. Moving without a strafe snaps to the aim; standing, it chases.
    if (moving && strafe === 0) {
      player.move.modelYaw = yaw;
    } else if (!moving) {
      const gap = wrapPi(yaw - player.move.modelYaw);
      const chase = Math.min(1, (STATIONARY_CHASE_RATE * TURN_RATE * delta) / Math.PI);
      player.move.modelYaw += gap * chase;
    }

    player.syncViewFromMove();

    // 6b. Tell the server. AFTER the frame and the heading, so the position and facing we send are
    // the ones we just drew -- a pre-frame send is a systematic one-frame lag in everything the
    // server and every other player sees. A no-op when nothing has entered the world
    // (`/game?offline=1`, and every movement test), because no sink is attached then.
    streamMovement(player.move, { forward, strafe, turning }, now);

    // 7. Seat the camera. Its cast uses the CAMERA face set, not the walking one, so it stops at
    // overhangs the player walks under and threads railings the player stands on.
    const head = player.move.pos.clone();
    head.z += CAPSULE_HEIGHT - CAPSULE_RADIUS;

    beginSection('ctl.cam');
    const seat = seatCamera(this.rig, {
      feet: player.move.pos,
      head,
      pivotHeight: headHeight(null, 1),
      cast: collisionWorld.castFor(CollisionLayer.Camera, CAM_COLLISION_RADIUS, 0),
      dt: delta,
    });

    endSection('ctl.cam');

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
