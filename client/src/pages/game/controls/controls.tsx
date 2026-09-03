import { beginSection, endSection } from '../../../game/perf/anim-section';
import React from 'react';
import * as THREE from 'three';

import {
  CAM_COLLISION_RADIUS, CLICK_DRAG_THRESHOLD, CameraControl, advanceZoom, applyZoomScroll,
  createCameraControl, createPendingClicks, runLookSession, seatCamera,
} from '../../../game/camera/rig';
import { headHeight } from '../../../game/camera/pivot';
import { collisionWorld, noteMovementFrame } from '../../../game/collision/collision-world';
import { beginCollisionFrame } from '../../../game/collision/doodad-provider';
import { CollisionLayer } from '../../../game/collision/types';
import {
  CAPSULE_HEIGHT, CAPSULE_RADIUS, GROUND_COS, MOUSELOOK_BODY_TURN_RATE, MOUSELOOK_PITCH_CLAMP,
  RUN_BACK_RATIO, RUN_SPEED,
  SETTLE_STREAM_TIMEOUT, SETTLE_TIMEOUT, STATIONARY_CHASE_RATE, TURN_RATE, TURN_RATE_MOVING,
  capsuleHalfSegment,
  SETTLE_FLOOR_REACH,
} from '../../../game/movement/constants';
import { movementFrame } from '../../../game/movement/frame';
import { moveTrace } from '../../../game/movement/move-trace';
import { easeDisplayYaw, strafeBodyOffset } from '../../../game/movement/net-motion';
import { movementFlagsFor, streamMovement, streamSplineDone } from '../../../game/movement/outbound';
import { serverRideFrame, serverRideStats } from '../../../game/movement/server-ride';
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
  /**
   * The name of the widget that CONSUMED this press, or null when the press belongs to the world.
   *
   * Asked once per `mousedown`, before anything is latched. A non-null answer means the UI took the
   * press -- the player is clicking, or starting a drag on, one of the client's own frames -- and the
   * camera must not see the button at all: not the orbit, not the mouse-look weld, not the pointer lock.
   *
   * THE POINTER LOCK IS WHY THIS IS NOT COSMETIC. `update` asks for one the moment `rig.look` is set,
   * and under a lock `clientX/clientY` FREEZE (see `onMouseMove`). So a left-press on an action button
   * used to start an orbit, take the lock, and freeze the very coordinates the UI router's drag needs --
   * the camera swung and the ability could never be dropped anywhere, which is the owner's report.
   *
   * A function rather than a boolean prop because the answer must be read AT the press: a prop would
   * carry whatever the last React render saw, and nothing re-renders this component on a pointer event.
   */
  uiCapturedPress?: () => string | null;
  /**
   * The name of the EditBox that owns the keyboard, or null. See `WorldUiHost#keyboardFocus`.
   *
   * Absent (plain `/game`, which has no FrameXML host) means nothing can own it, so the world keeps
   * every key -- the same fallback `uiCapturedPress` takes.
   */
  uiKeyboardFocus?: () => string | null;
  /**
   * A cancel-worthy MOVEMENT EDGE just happened: a directional start (forward / backward / strafe) or a
   * jump-key press. Fired once per edge, never while a key is merely held.
   *
   * The one consumer is the cast self-cancel (`game/classes/cast-cancel.ts`), which is why the
   * membership of "cancel-worthy" is not this file's to choose: the real client's interrupt mask is
   * `0x10f0` = {forward, backward, strafe L, strafe R, autorun}, and **TURN and PITCH are outside it**.
   * That is exactly the split this file already computes below -- `strafe` versus `turning` -- so the
   * edge is taken from those two and a keyboard turn deliberately raises nothing.
   */
  onMoveStart?: () => void;
}

/** One press, as `captureLog` records it. */
export interface CaptureRecord {
  /** `performance.now()` at the press. */
  time: number;
  /** `MouseEvent.button`: 0 left, 2 right. */
  button: number;
  /** The widget that claimed it, or null for a press on the world. */
  claimedBy: string | null;
  /** Whether `controls` latched the button -- i.e. whether the camera saw this press. */
  controlsSaw: boolean;
}

/**
 * THE CAPTURE INSTRUMENT: who claimed each press, and whether the camera also saw it.
 *
 * Built because the question cannot be answered any other way in this environment. `page.mouse` cannot
 * hold a button and move the pointer in this headless Chrome (measured four ways -- see STATE.md), so a
 * synthetic drag proves nothing about Chrome's own event generation, which is exactly the link the
 * camera-during-drag bug lives on. Two independent readings per press instead: what the UI router
 * decided, and what `controls` then did about it. `claimedBy` non-null with `controlsSaw` false IS the
 * fix working, and either half alone would not say so.
 *
 * A bounded ring, because a play session presses the mouse thousands of times.
 */
const CAPTURE_LOG_LIMIT = 200;

const captureLog: CaptureRecord[] = [];

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

  /**
   * Whether a DIRECTIONAL key was down last frame -- forward, backward or strafe, never turn.
   *
   * The cast self-cancel wants the START of movement, so it needs the 0 -> nonzero transition and not
   * "is moving": a cast begun while already running must not be cancelled by the same key still being
   * held. See `onMoveStart` in `IProp` for why turn is excluded.
   */
  private wasDirectional = false;

  /** Pointer lock already asked for in this look session. See the request site for why. */
  private lockRequested = false;

/**
   * How far the pointer has travelled during the current button-held drag, in device pixels.
   *
   * The pointer lock is gated on this crossing `LOCK_TRAVEL_PX`, not on the button and not on "did it
   * move at all" -- see the gate in the frame loop.
   */
  private lookTravel = 0;

  /**
   * How far the pointer must travel during a hold before the camera is considered to be MOVING and the
   * pointer lock is worth taking. Device pixels, accumulated as |dx| + |dy|.
   *
   * OURS, and the owner set the rule rather than the number: "такой эффект должен быть только при
   * движении камеры. У нас же она статична во время общения или лутания."
   *
   * The previous attempt gated on any nonzero delta and was still wrong, which he also diagnosed
   * exactly -- a real mouse jitters a pixel during any click, so "did it move" was true almost
   * immediately and the lock was taken for a click after all. That is why this is a threshold and not a
   * boolean.
   *
   * 4 px is the conventional click-versus-drag slop and it is deliberately small: crossing it late costs
   * nothing, because the first pixels of a genuine drag come from the UNLOCKED `movementX/Y`, which
   * browsers deliver either way. Crossing it early costs the cursor, which is the whole complaint.
   */
  private static readonly LOCK_TRAVEL_PX = 4;

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
    // `window.uiCaptureLog` -- see `captureLog`. Published from the mount rather than at module scope so
    // it exists only while something is actually reading the mouse.
    (window as never as Record<string, unknown>).uiCaptureLog = captureLog;

    /**
     * **`window.stuckReport()` -- ONE CALL, NO ARMING, ANSWERED WHILE STUCK.**
     *
     * Every instrument in this area so far has had to be armed before the event and read after it,
     * and that has cost this round four readings: a trap read thirty frames of standing at the
     * console, a counter that drained on release, a live field overwritten before it could be read,
     * and a trace switched off in the same line that switched it on. A body that is stuck is stuck
     * NOW -- so the honest instrument for it is a snapshot, and the owner can call it while it is
     * happening.
     *
     * THE 36 BEARINGS are the measurement this codebase has referred to twice without ever having:
     * "0 of 36 bearings free" appears in `step-up.ts` as evidence from a past round. `free` at 36
     * means nothing is holding the body horizontally and the freeze is in the MOVER; a small number
     * means it is genuinely walled in and the geometry is the story; anything between says which way
     * out exists, which is the question "I cannot leave" actually asks.
     *
     * THE MOVE STATE is the other half and may be the whole answer. `settling` freezes the body and
     * switches gravity off until streamed collision arrives, `wedged` and `stepDown` both report
     * "standing" to the caller, and any of the three latched is a freeze with no geometry involved
     * at all -- which is exactly what "хотя я даже не в нем, но я не могу идти" describes.
     */
    /**
     * **`?sinktrap=1` -- THE ONLY TRAP THAT CAN CATCH A FALL AT WORLD ENTRY.**
     *
     * The owner: "я прогружаюсь под лестницей." His settle log releases the hold at z **82**, the
     * stairs level, and under the staircase is **80.6** -- so the fall happens in the first second,
     * after a release that was healthy in every respect the log records (a floor within five yards,
     * the terrain registered). Every trap in this area is armed from the console, and a page reload
     * clears the console, so there has never been a way to be watching when it happens.
     *
     * Armed HERE, at the controls mount, which runs before the world finishes streaming -- so the trap
     * is already live when the body first touches geometry. It freezes both traces on the first frame
     * the capsule is a tenth of a yard inside anything, which is the entry and not the aftermath.
     *
     * A query flag rather than a default, for the reason everything else here is: the trace costs a
     * per-frame record, and an instrument that is on when nobody asked is how a profile comes back
     * inflated -- which has already happened once this round.
     */
    if (new URLSearchParams(window.location.search).get('sinktrap') === '1') {
      // eslint-disable-next-line no-console
      console.log(`[sinktrap] ${moveTrace.armSink(0.1)}`);
    }

    (window as never as Record<string, unknown>).stuckReport = () => {
      const cast = collisionWorld.castFor(CollisionLayer.Walk, CAPSULE_RADIUS, capsuleHalfSegment());
      const push = collisionWorld.depenetrateFor(
        CollisionLayer.Walk, CAPSULE_RADIUS, capsuleHalfSegment(), GROUND_COS,
      );
      const move = this.unit.move;
      const centre = move.pos.clone();
      centre.z += CAPSULE_HEIGHT * 0.5;

      const name = (source: object): string => {
        const named = source as { group?: { path?: string; index?: number } };
        if (typeof named.group?.path === 'string') {
          return `wmo ${named.group.path}#${named.group.index ?? 0}`;
        }
        return source.constructor?.name ?? 'unknown';
      };

      // Half a yard: further than a frame of walking and shorter than the gaps a body threads, so a
      // blocked bearing here is a wall rather than something noticed early.
      const PROBE = 0.5;
      /**
       * **THE FULL NORMAL, not just its Z -- because Z alone cannot tell the two diagnoses apart.**
       *
       * The first reading came back 36 of 36 blocked, every bearing at distance 0 with `nz: 0.01`.
       * That looks like one face blocking every direction, which would be a defect in the sweep --
       * but every VERTICAL face has the same `nz` by construction, so the reading cannot distinguish
       * one face from twelve. The normal's direction can: identical vectors across opposed bearings
       * is the sweep refusing a direction it should allow, while vectors that point outward from the
       * body in every bearing is a capsule genuinely enclosed by a hull.
       *
       * The sweep itself is not the suspect it looked like -- its already-touching branch does gate
       * on the closing speed (`capsule-cast.ts`, `closing > 1e-9`), so a receding direction is
       * refused. That was read rather than assumed.
       */
      const blocked: {
        deg: number; d: number; n: number[]; src: string; same: boolean;
      }[] = [];
      let firstSource: object | null = null;
      const sources = new Set<object>();
      let free = 0;
      for (let i = 0; i < 36; i += 1) {
        const angle = (i * 10 * Math.PI) / 180;
        const dir = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
        const hit = cast(centre, dir, PROBE);
        /**
         * **A HIT AT 0.22 YD IS ROOM TO WALK, NOT A WALL -- and counting it as blocked made me
         * read a POCKET as a cage.**
         *
         * Under the abbey stairs the report said 0 of 36 free, and seven of those bearings were hits
         * at 0.049 to 0.225 yd: a fifth of a yard of clearance, against the terrain, with walkable
         * normals. Only five bearings were at zero -- the underside of the stone ramp. The body was
         * in a narrow pocket it could shuffle inside, which is a different defect from the fence,
         * where all thirty-six really were zero.
         *
         * So a bearing is FREE if it has room, blocked only if the contact is immediate. The
         * threshold is one frame of walking: at 7 yd/s and 60 Hz that is about 0.117, so anything
         * under a tenth of a yard cannot even be stepped into.
         */
        if (hit === null || hit.distance > 0.1) {
          free += 1;
        }
        if (hit !== null) {
          if (firstSource === null) {
            firstSource = hit.source;
          }
          sources.add(hit.source);
          blocked.push({
            deg: i * 10,
            d: Number(hit.distance.toFixed(3)),
            n: [hit.normal.x, hit.normal.y, hit.normal.z].map((v) => Number(v.toFixed(3))),
            src: name(hit.source),
            same: hit.source === firstSource,
          });
        }
      }

      const up = cast(centre, new THREE.Vector3(0, 0, 1), 1.0);
      const down = cast(centre, new THREE.Vector3(0, 0, -1), 3.0);
      const overlap = { source: null as string | null, normalZ: 0, gap: 0 };
      const freed = push(centre, 0, false, overlap);

      return {
        feet: [move.pos.x, move.pos.y, move.pos.z].map((v) => Number(v.toFixed(3))),
        freeBearings: free,
        // Every bearing with any contact inside the probe, free or not -- the `d` on each row says
        // which. `freeBearings` is the one to read for "can I leave".
        contactBearings: blocked.length,
        blockedAtZero: blocked.filter((b) => b.d <= 0.1).length,
        // Every SECOND bearing, so twenty degrees of the circle fit in one readable object and
        // opposed directions (0 and 180) are both present -- which is the pair that matters.
        blocked: blocked.filter((_, i) => i % 3 === 0),
        distinctSources: sources.size,
        up: up === null ? null : { d: Number(up.distance.toFixed(3)), src: name(up.source) },
        down: down === null ? null : {
          d: Number(down.distance.toFixed(3)),
          nz: Number(down.normal.z.toFixed(2)),
          src: name(down.source),
        },
        overlap,
        pushWould: freed === null ? null : Number(freed.distanceTo(centre).toFixed(4)),
        /**
         * **THE EYE, IN NUMBERS -- because ten commits into this thread the screenshots stopped
         * deciding anything.**
         *
         * Four different frames were reported as "то же самое", and they were not the same picture: a
         * building gone, a room over a void, a room over dirt, a camera pressed into a pillar. I was
         * reading intent out of pixels and getting it wrong about half the time. Whether the EYE is
         * below the floor is one subtraction, and it settles in one reading what four rounds of looking
         * could not.
         *
         * `eyeToFeet` negative means the eye is beneath the feet. `downFromEye` is what the WALK
         * audience finds below the eye -- the audience that now holds the floor -- so a hit at a short
         * distance with an upward normal means there IS floor under the eye and it is above it.
         * `upFromEye` finding a DOWNWARD normal is the opposite and is the broken state outright.
         */
        eye: (() => {
          const cam = this.props.camera;
          if (!cam) return null;
          const eye = cam.position.clone();
          const down = cast(eye, new THREE.Vector3(0, 0, -1), 6);
          const up = cast(eye, new THREE.Vector3(0, 0, 1), 6);
          return {
            at: [eye.x, eye.y, eye.z].map((v) => Number(v.toFixed(3))),
            eyeToFeet: Number((eye.z - move.pos.z).toFixed(3)),
            boom: Number(this.rig.collisionDistance.toFixed(3)),
            zoom: Number(this.rig.distance.toFixed(2)),
            downFromEye: down === null ? null : {
              d: Number(down.distance.toFixed(3)),
              nz: Number(down.normal.z.toFixed(3)),
              src: name(down.source),
            },
            upFromEye: up === null ? null : {
              d: Number(up.distance.toFixed(3)),
              nz: Number(up.normal.z.toFixed(3)),
              src: name(up.source),
            },
          };
        })(),

        move: {
          velZ: Number(move.velZ.toFixed(3)),
          horizVel: Number(move.horizVel.length().toFixed(3)),
          airborneSince: move.airborneSince,
          settling: move.settling,
          wedged: move.wedged,
          stepDown: move.stepDown,
          swimming: move.swimming,
          // The server-ride hand-off, so a charge can be read without a console. `serverRiding`
          // true means the spline owns the pose and the mover is parked this frame; a
          // `rideStopSplineId` still set with nothing riding is an ack owed and not yet paid.
          serverRiding: move.serverRiding,
          rideSplineId: move.rideSplineId,
          rideStopSplineId: move.rideStopSplineId,
          ride: { ...serverRideStats },
        },
      };
    };
    this.element.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    this.element.addEventListener('mousemove', this.onMouseMove);
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
  }

  componentWillUnmount() {
    this.element.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.element.removeEventListener('mousemove', this.onMouseMove);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
  }

  private onContextMenu(event: Event) {
    // Right-drag turns the character; the browser menu must not interrupt it.
    event.preventDefault();
  }

  private onMouseDown(event: MouseEvent) {
    /**
     * THE UI GETS THE PRESS FIRST, and a press it took is not a press for the camera.
     *
     * `pointerdown` on the canvas has already run by the time this fires -- the compatibility mouse
     * event follows the pointer event for the same press -- so `uiCapturedPress()` reads a decision the
     * router made from the same coordinates, through the same `hitTest` on the same draw list the frame
     * was drawn from. Asking the router rather than hit-testing again here is the rule
     * `pages/game/index.tsx#onWorldClick` already follows for the CLICK: a second, independent test is
     * a second answer that can differ, invisibly.
     *
     * Returning BEFORE `this.pointer` is updated as well as before the button latch. The pointer is the
     * pick point for a world click, and a press the world never saw must not move where the next one
     * picks.
     */
    const claimedBy = this.props.uiCapturedPress?.() ?? null;
    if (captureLog.length >= CAPTURE_LOG_LIMIT) {
      captureLog.shift();
    }
    captureLog.push({
      time: performance.now(), button: event.button, claimedBy, controlsSaw: claimedBy === null,
    });
    if (claimedBy !== null) {
      return;
    }
    this.pointer.x = event.clientX;
    this.pointer.y = event.clientY;
    if (event.button === 0) this.buttons.left = true;
    if (event.button === 2) this.buttons.right = true;
  }

  private onMouseUp(event: MouseEvent) {
    if (event.button === 0) this.buttons.left = false;
    if (event.button === 2) this.buttons.right = false;
    if (!this.buttons.left && !this.buttons.right) {
      // A new drag starts with no travel: see the lock gate.
      this.lookTravel = 0;
    }
    /**
     * NO `pointerLockElement` GUARD, and its absence is the fix for the oldest open report on this
     * project: "when I do right click, cursor disappears for some reason and clicking left button makes
     * it appear again."
     *
     * The guard read as a cheap "are we even locked" test and was in fact the bug, because of the thing
     * the frame loop below already documents at length: **the lock is granted ASYNCHRONOUSLY, so
     * `pointerLockElement` stays null for the whole handshake.** The sequence for any quick right click:
     *
     *   1. press -> `buttons.right`
     *   2. next frame -> `requestPointerLock()` goes out
     *   3. release, still mid-handshake -> `pointerLockElement` is null, so the exit was SKIPPED
     *   4. the lock lands, with no button held and nothing left to release it -- the browser hides the
     *      cursor and keeps it hidden
     *   5. a left click's release finally finds `pointerLockElement` set and exits -- "clicking left
     *      button makes it appear again", exactly as reported
     *
     * Calling `exitPointerLock()` when nothing is locked is a documented no-op, so dropping the guard
     * costs nothing and closes steps 3-5. `onPointerLockChange` closes the remaining ordering, where the
     * grant arrives after this handler has already run.
     */
    if (!this.buttons.left && !this.buttons.right) {
      document.exitPointerLock();
    }
  }

  /**
   * A LOCK THAT ARRIVES AFTER THE DRAG ENDED MUST NOT STAY.
   *
   * The belt to `onMouseUp`'s braces, and it is what makes the fix ordering-proof rather than merely
   * likely: whatever sequence the browser chooses, a pointer lock held while no mouse button is down is
   * a hidden cursor with nothing holding it. This is the only place that can catch the grant itself, so
   * it is checked here rather than trusted to the release.
   */
  private readonly onPointerLockChange = () => {
    if (document.pointerLockElement === this.element
      && !this.buttons.left && !this.buttons.right) {
      document.exitPointerLock();
    }
  };

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
    const dx = event.movementX ?? 0;
    const dy = event.movementY ?? 0;
    // ACCUMULATED TRAVEL, not "did it move at all" -- see `LOCK_TRAVEL_PX`.
    this.lookTravel += Math.abs(dx) + Math.abs(dy);
    this.motion.dx += dx;
    this.motion.dy += dy;
  }

  private onWheel(event: WheelEvent) {
    event.preventDefault();
    this.scrollNotches += event.deltaY > 0 ? -1 : 1;
  }

  /**
   * A PRESS THE CHAT FIELD OWNS IS NOT A PRESS FOR THE WORLD.
   *
   * Typing into chat walked the character: this listener is on `document` and reads `event.code`
   * directly, so it never saw the focus rule `ui/input.ts` already applies to bound keys. Asking the
   * host rather than tracking focus here is the rule `onMouseDown` follows for the press -- a second,
   * independent test is a second answer that can differ, invisibly.
   *
   * `keys.clear()` on the way in, because a key held when the field TOOK focus would otherwise stay
   * in the set for ever: its release is a `keyup` this component still processes, but a `W` held while
   * Enter opened the box gets no release at all if the browser delivers it elsewhere. Clearing is the
   * same latch-release `onPointerCancel` does for a lost press.
   *
   * `onKeyUp` is deliberately NOT gated: a release must always be able to lift a key this set is
   * holding, whoever owns the keyboard by then.
   */
  private onKeyDown(event: KeyboardEvent) {
    if ((this.props.uiKeyboardFocus?.() ?? null) !== null) {
      this.keys.clear();
      return;
    }
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

    // **OPEN THE COLLISION FRAME BEFORE ANY CAST IS ISSUED.** Every doodad hull refreshes its world
    // matrix once per epoch instead of once per cast, which is where ~2.9 ms of `ctl.move` was going
    // -- `collision/doodad-provider.ts#beginCollisionFrame` carries the measurement. It must be here,
    // at the top of the frame's own update, and not in the movement census: that is stamped AFTER the
    // mover has already cast, so an epoch bumped there would refresh nothing in time.
    beginCollisionFrame();

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
    /**
     * THE LOCK WAITS FOR ACTUAL MOVEMENT, and that is what finally fixes the vanishing cursor.
     *
     * Dropping `onMouseUp`'s stale guard was necessary and not sufficient: the owner still saw the cursor
     * go, and gave the detail that settles it -- **"появляется по первому движению мыши"**. A pointer
     * lock does not restore a cursor on movement, and a CSS `url(...)` cursor is repainted only when the
     * pointer moves. So the lock WAS being exited correctly; the browser simply had not repainted the
     * custom cursor yet, and would not until the mouse moved.
     *
     * Which means the flash was never worth having in the first place: **a click does not need a pointer
     * lock at all.** The lock exists so `movementX/Y` keep arriving past the edge of the screen during
     * mouse-look, and a press-and-release with no movement is not mouse-look. Requesting it on the frame
     * the button goes down bought a lock, a hide and an exit for every single right click on an NPC.
     *
     * So it waits for a real delta. The first few pixels of a genuine drag come from the UNLOCKED
     * `movementX/Y`, which browsers deliver either way, so nothing about mouse-look changes -- it locks a
     * frame later and from then on behaves exactly as before.
     */
    if (this.rig.look && this.lookTravel > Controls.LOCK_TRAVEL_PX) {
      if (!this.lockRequested && !document.pointerLockElement) {
        this.lockRequested = true;
        // Newer Chrome returns a promise here and older ones return undefined; an unhandled
        // rejection was reported as "a promise was rejected with a non-error" either way.
        Promise.resolve(this.element.requestPointerLock?.()).catch(() => undefined);
      }
    } else if (!this.rig.look) {
      this.lockRequested = false;
    }

    // MOUSE-LOOK: the body IS the camera heading, by ABSOLUTE assignment.
    //
    // `faceYaw += look.yawDelta` -- what this was -- keeps the two only as parallel as they already
    // were, and a left-drag orbit is precisely what makes them diverge: the camera swings round to
    // your side, the body does not, and from then on the two disagree by the orbit. Then you hold the
    // right button, and in the real client the character SNAPS to face where the camera is looking and
    // stays welded to it -- so W walks exactly where you are looking. Ours kept walking off at the old
    // heading. That is the owner's items 8 and 9, and both are this one line.
    //
    // The reference is unambiguous that it is an assignment and not an increment
    // (`samples/benilla/crates/benilla/src/player/camera.rs:342-353`):
    //   `if active == LookButton::Right || both_buttons { *face_yaw = cam.yaw; }`
    // with the same comment: "Right-drag also turns the character (its facing tracks the camera yaw);
    // left-drag leaves the character facing."
    // GATED ON A REAL DRAG, not on the button being down. `runLookSession` sets `rig.look = 'right'`
    // INSTANTLY on press (`rig.ts:326`, "instant on press") because a right-drag must turn from the
    // first pixel -- so keying the weld off `rig.look` alone made every right CLICK snap the body to
    // the camera for the frames the button was held. A right click is how this client starts auto
    // attack (`pages/game/index.tsx:306`) and how it would interact, and spinning the character every
    // time you click a wolf is not what the real client does. `pendingRight` is the same accumulated
    // drag distance the session's own click-versus-drag test uses, so the two cannot disagree about
    // what a click is.
    const rightDragging = this.rig.look === 'right'
      && (this.pending.right === null || this.pending.right >= CLICK_DRAG_THRESHOLD);
    const mouselook = rightDragging || look.bothButtonsRun;
    if (mouselook) {
      player.move.faceYaw = this.rig.yaw;
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

    // 2b. **THE SERVER-RIDE GUARD: a server-authored spline owns the avatar this frame.**
    //
    // Charge, a knockback path, a taxi flight, a fear flee -- all of them arrive as an
    // `SMSG_MONSTER_MOVE` naming our own guid, and while one is running the spline is the sole
    // authority over `move.pos` and the facing. Input, the capsule mover and the outbound movement
    // stream all yield; only the camera keeps seating, on the body the spline is moving. That is
    // the reference's own division of labour and its own guard placement
    // (`benilla-app/src/player/server_ride.rs` for the mirror, `player.rs:800-886` for the guard).
    //
    // WHY HERE, after the look session and the zoom and before the keyboard. Mouse-look and zoom
    // are camera input and must keep working through a charge -- you can spin the view while being
    // dragged -- and step 1's right-drag weld writes `faceYaw` from the camera, which
    // `serverRideFrame` then overwrites from the path tangent, so the spline wins the facing for as
    // long as it runs. Everything from step 3 down is body input, and body input is what yields.
    //
    // The keyboard is not read at all here, which is deliberate twice over: no `onMoveStart` fires,
    // so being charged does not cancel your own cast the way pressing W does (the interrupt is a
    // KEYPRESS test -- see step 3's `directional` edge); and the jump latch is DROPPED rather than
    // queued, because a Space pressed mid-ride is a jump the real client never took and a queued
    // one would fire on the arrival frame.
    const ride = serverRideFrame(player.move, player.splineRide, performance.now());
    if (ride.clearRide) {
      player.clearSplinePath();
    }
    if (ride.verdict === 'engaged') {
      // Once per ride, and it is the instrument the owner reads: the counter part lives on
      // `monsterMovementHandler.stats.selfMoves`.
      // eslint-disable-next-line no-console
      console.log(
        `[ride] server spline ${player.move.rideSplineId} drives the avatar`
        + ` (${player.splineRide ? player.splineRide.points.length : 0} pts,`
        + ` ${player.splineRide ? player.splineRide.durationMs : 0} ms)`,
      );
    }
    if (ride.ackSplineId !== null) {
      // The server holds our mover spline-controlled -- and DROPS every movement packet we send --
      // until this arrives. Sent before the resumed frame streams anything of its own, so the
      // release is the first thing the server sees.
      streamSplineDone(player.move, ride.ackSplineId);
    }
    if (ride.riding) {
      // The spline's pose, onto the scene graph. `move.modelYaw` was written by the ride, so this
      // is the same one-line hand-off the ordinary frame ends with.
      player.syncViewFromMove();
      this.jumpPressed = false;
      this.seatFollowCamera(player, delta);
      return;
    }

    // 3. Keyboard. A/D TURN in vanilla rather than strafing; Q/E strafe.
    //
    // EXCEPT UNDER MOUSE-LOOK, where A/D become STRAFE and turn nothing -- the mouse owns the heading
    // while it is held, so a turn key would fight it (`player.rs:663-709`: `side_axis = E - Q + if
    // mouselook { D - A }`, and `turning = !mouselook && ...`). Without this, holding the right button
    // and pressing A both turned the body away from the camera and then had it snapped back next
    // frame by the mouse-look lock above -- the key did nothing at all, visibly.
    const forward = (this.held('KeyW', 'ArrowUp') || look.bothButtonsRun ? 1 : 0)
      - (this.held('KeyS', 'ArrowDown') ? 1 : 0);
    const strafeKeys = (this.held('KeyQ') ? 1 : 0) - (this.held('KeyE') ? 1 : 0);
    const turnKeys = (this.held('KeyA', 'ArrowLeft') ? 1 : 0)
      - (this.held('KeyD', 'ArrowRight') ? 1 : 0);
    const strafe = mouselook ? strafeKeys + turnKeys : strafeKeys;
    const turning = mouselook ? 0 : turnKeys;

    // THE CAST SELF-CANCEL'S EDGE. Computed here, at the one place that knows which keys turned and
    // which translated -- the distinction the real client's `0x10f0` interrupt mask draws and that a
    // downstream "is the player moving" test could not recover. The jump key is in the mask too
    // (`Script::Jump 0x513bd0` inlines the same gate) and fires on the PRESS, which is what
    // `jumpPressed` already is -- it is read here before the frame loop clears it below.
    const directional = forward !== 0 || strafe !== 0;
    if ((directional && !this.wasDirectional) || this.jumpPressed) {
      this.props.onMoveStart?.();
    }
    this.wasDirectional = directional;

    if (turning !== 0) {
      const rate = TURN_RATE * (this.isTranslating(forward, strafe) ? TURN_RATE_MOVING : 1);
      const turnDelta = turning * rate * delta;
      player.move.faceYaw += turnDelta;
      // A KEYBOARD TURN CARRIES THE CAMERA. `rig.look` is null here by construction (a turn key only
      // turns when the mouse is not looking), and the reference moves the camera with the body on
      // exactly that condition -- `camera.rs:417-419`, `if rig.look.is_none() { cam.yaw += turn_delta }`.
      // Without it, A/D swung the body while the camera stayed put, so the view drifted round to the
      // character's flank and every subsequent right-click snapped him somewhere he had not asked for.
      this.rig.yaw += turnDelta;
    }

    // 4. Movement direction, expressed in the facing basis.
    //
    // The SIGN of each axis, not its magnitude: under mouse-look `strafe` is the sum of two key pairs
    // and can reach +/-2, which would weight the strafe axis double against forward and send a
    // Q-plus-A diagonal out at 63 degrees instead of 45. The reference takes "one step per netted axis
    // sign" (`player.rs:710-728`).
    const yaw = player.move.faceYaw;
    const fwdAxis = Math.sign(forward);
    const sideAxis = Math.sign(strafe);
    const dir = new THREE.Vector3(
      Math.cos(yaw) * fwdAxis - Math.sin(yaw) * sideAxis,
      Math.sin(yaw) * fwdAxis + Math.cos(yaw) * sideAxis,
      0,
    );
    const moving = forward !== 0 || strafe !== 0;
    // THE SERVER'S SPEED, NOT THE CONSTANT -- and this is the owner's "не работают способности,
    // которые связаны с передвижением ... дух стаи".
    //
    // `RUN_SPEED`'s own docstring says it is "the fallback until server speeds stream in"
    // (`movement/constants.ts:22-25`), and NOTHING EVER STREAMED IT IN: the avatar moved at the
    // compile-time 7.0 whatever the wire said. So every movement-speed effect in the game was
    // inert on the player -- an Aspect-of-the-Pack style aura, a Sprint, a mount, a daze, a
    // snare. Not refused, not mis-drawn: applied to a number nobody read.
    //
    // The wire half was already complete and correct, which is why this is one expression and not
    // a feature: `MSG_MOVE_SET_RUN_SPEED` and `SMSG_FORCE_RUN_SPEED_CHANGE` are both decoded, the
    // force form is ACKED with the server's own change counter (the server resends and eventually
    // drops an unresponsive client otherwise), and `Unit#moveSpeed`'s setter validates the float
    // against `TELEPORT_SPEED` before forwarding it into `speeds.run`
    // (`network/game/object/player/movement.ts:339-341, 371-374`; `classes/unit.ts:592-617`).
    // `speeds` starts as a spread of `DEFAULT_MOVE_SPEEDS`, so before any packet arrives this reads
    // the same 7.0 it always did.
    //
    // BACKPEDAL TAKES THE WIRE'S OWN `runBack`, not `run * RUN_BACK_RATIO`. The ratio is vanilla's
    // 4.5/7.0 and is only correct while both are at their defaults -- a buff that scales `run`
    // leaves `runBack` alone on the wire, so deriving it would invent a backpedal speed the server
    // is not simulating and desync the position it checks. The ratio stays as the fallback for a
    // `runBack` that has not arrived.
    const speeds = player.speeds;
    const speed = forward < 0
      ? (speeds.runBack > 0 ? speeds.runBack : RUN_SPEED * RUN_BACK_RATIO)
      : (speeds.run > 0 ? speeds.run : RUN_SPEED);

    // 5. One movement frame. The claim is outdoor-only for now; see the note in Task 22.
    const claim = { wmoGroup: null };
    const deps = {
      cast: collisionWorld.castFor(CollisionLayer.Walk, CAPSULE_RADIUS, capsuleHalfSegment()),
      surfaceAt: (feet: THREE.Vector3) => (
        collisionWorld.surfaceAt(feet.x, feet.y, claim)?.surfaceZ ?? null
      ),
      /**
       * The push-out for a body INSIDE geometry. The mover calls it only when a step contacted
       * something, wanted to move and travelled nothing -- see `mover.ts#step`. Same audience and
       * same capsule as the cast above, because it is the same body.
       */
      depenetrate: collisionWorld.depenetrateFor(
        CollisionLayer.Walk, CAPSULE_RADIUS, capsuleHalfSegment(), GROUND_COS,
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
      // NEAR the feet, not anywhere below -- see `SETTLE_FLOOR_REACH`. At 200 yd this asked whether
      // the world had loaded at all, and answered yes from the terrain under a building whose own
      // floor had not arrived, which is what dropped the body through it.
      const resident = deps.cast(
        feetCentre, new THREE.Vector3(0, 0, -1), SETTLE_FLOOR_REACH,
      ) !== null;
      const groundStreamed = collisionWorld.terrain
        .heightAt(player.move.pos.x, player.move.pos.y) !== null;
      // How long we have been holding, reconstructed from the deadline. `PlayerMoveState` carries a
      // deadline rather than a start, and every writer of it (`Unit#teleportTo`, and the rescue
      // below) arms it at `now + SETTLE_TIMEOUT` -- so this subtraction is exact, and it is the ONE
      // thing that couples the two timeouts. A writer using a different offset would have to say so
      // here.
      const elapsed = now - (player.move.settleDeadline - SETTLE_TIMEOUT);

      const byTerrain = groundStreamed && elapsed >= SETTLE_TIMEOUT;
      const byCap = elapsed >= SETTLE_STREAM_TIMEOUT;
      if (resident || byTerrain || byCap) {
        player.move.settling = false;

        /**
         * **THE RELEASE ANNOUNCES ITSELF, because a post-load fall cannot be trapped by hand.**
         *
         * Every other instrument in this area is armed from the console, and a page reload clears
         * the console while the fall happens in the first second of the world. So the one event that
         * decides it has to speak for itself: which of the three conditions fired, how long the hold
         * lasted, whether the terrain was registered, and how far the floor probe reached.
         *
         * `resident` releasing at once with `ground: false` is the shape of the defect -- a floor
         * within five yards but no registered terrain means a WMO floor and nothing under it yet.
         * `byTerrain` after six seconds means the probe never found a floor and we let go on the
         * timer, which is a legitimate cliff OR a floor that never arrived. `byCap` at thirty is the
         * backstop and always worth knowing about.
         *
         * Once per teleport or world entry, so it adds nothing to a running session.
         */
        // `log` rather than `warn`: React DevTools overrides `warn` to append a component
        // stack, which buried this one line under forty of `requestAnimationFrame`.
        // eslint-disable-next-line no-console
        console.log(
          `[settle] released by ${resident ? 'floor' : (byTerrain ? 'terrain-timeout' : 'cap')}`
          + ` after ${elapsed.toFixed(2)}s -- floorWithin${SETTLE_FLOOR_REACH}yd=${resident},`
          + ` terrainRegistered=${groundStreamed},`
          + ` at ${player.move.pos.x.toFixed(1)}, ${player.move.pos.y.toFixed(1)}, ${player.move.pos.z.toFixed(1)}`,
        );
      }
    }

    beginSection('ctl.move');
    // TIMED HERE TOO, and deliberately over exactly the span `ctl.move` covers: `CpuSections` keeps
    // only a per-frame total with no history, so there is no p50 to read out of it -- and a p50 is
    // the whole point, since five single samples of this line span 4.1 to 10.2 ms. Two clock reads a
    // frame buys `window.moveProfile()` a median over the last 512 frames.
    const moveStartedAt = performance.now();
    movementFrame(player.move, deps, {
      moving, dir, speed, wantJump: this.jumpPressed, jumpPressed: this.jumpPressed,
      // The swim pair travels the same way the run speed does, and for the same reason.
      swimSpeed: speeds.swim, swimBackSpeed: speeds.swimBack,
    }, delta, now);
    noteMovementFrame(performance.now() - moveStartedAt);
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

    // 6. THE RENDERED BODY HEADING -- the client's display-facing blend, ported from the reference's
    // body-heading driver (`samples/benilla/crates/benilla/src/player/gait.rs:36-77`).
    //
    // A STRAFE IS A BODY YAW, NOT A GAIT. WoW has no ground strafe animation at all: the run cycle
    // keeps playing and the whole strafe is expressed by turning the body off the aim -- a right angle
    // for a pure strafe, 45 degrees when forward or back is held too, mirrored when backpedalling
    // (`strafeBodyOffset`). Until now the strafing branch of this `if` did NOTHING: `moving && strafe
    // !== 0` fell through every arm, so the body kept whatever heading it last had and the avatar
    // side-stepped facing dead ahead. That is the owner's item 7, and the 45 degrees he asked for is
    // the diagonal case.
    //
    // Swimming SNAPS the display facing to the aim -- no offset, no ease. That is the client's own
    // facing-snap list (dead or swimming), the same gate the peer path applies.
    //
    // The standing branch is a FROZEN chase with a 90-degree ceiling while steering, which is what
    // produces WoW's head-leads-then-body-follows turn in place -- `constants.ts#STATIONARY_CHASE_RATE`
    // has described this since it was written and the code chased unconditionally instead, so a
    // standing mouse-turn dragged the body round rigidly with the camera.
    const flagsNow = movementFlagsFor(player.move, { forward, strafe, turning });
    const bodyOffset = player.move.swimming ? 0 : strafeBodyOffset(flagsNow);
    const steering = turning !== 0 || mouselook;
    if (player.move.swimming) {
      player.move.modelYaw = yaw;
    } else if (bodyOffset !== 0) {
      player.move.modelYaw = easeDisplayYaw(player.move.modelYaw, yaw, bodyOffset, delta);
    } else if (moving || player.move.airborneSince !== null) {
      player.move.modelYaw = yaw;
    } else {
      const gap = wrapPi(yaw - player.move.modelYaw);
      // The CEILING: however the aim moves, the body is never left more than 90 degrees off it, so a
      // steering turn drags the shoulders along only once the head has led that far.
      //
      // RATE-CAPPED, which the reference does not do -- see `MOUSELOOK_BODY_TURN_RATE`. A fast flick
      // moves the aim tens of degrees in one frame, and an uncapped ceiling term hands the whole of
      // that to the body in that frame: the shoulders snap round as fast as the hand moved. Capped at
      // the character's own turn rate the body follows a flick at pi rad/s and finishes with the
      // release sweep, which is the owner's "медленнее". A slow turn is under the cap and is unchanged.
      let step = Math.min(
        Math.max(0, Math.abs(gap) - Math.PI / 2),
        MOUSELOOK_BODY_TURN_RATE * delta,
      );
      if (!steering) {
        // The RELEASE SWEEP: once steering stops, the body closes on the aim at `turnRate x 8`.
        step += STATIONARY_CHASE_RATE * TURN_RATE * delta;
      }
      player.move.modelYaw = wrapPi(
        player.move.modelYaw + Math.sign(gap) * Math.min(step, Math.abs(gap)),
      );
    }

    player.syncViewFromMove();

    // 6b. Tell the server. AFTER the frame and the heading, so the position and facing we send are
    // the ones we just drew -- a pre-frame send is a systematic one-frame lag in everything the
    // server and every other player sees. A no-op when nothing has entered the world
    // (`/game?offline=1`, and every movement test), because no sink is attached then.
    streamMovement(player.move, { forward, strafe, turning }, now);

    // 7 + 8. Seat the camera and settle the first-person fade.
    this.seatFollowCamera(player, delta);
  }

  /**
   * Seat the follow camera on the avatar and settle the first-person body fade.
   *
   * Its cast uses the CAMERA face set, not the walking one, so it stops at overhangs the player
   * walks under and threads railings the player stands on.
   *
   * Factored out because the SERVER-RIDE guard needs exactly this and nothing else: the reference
   * parks input, physics and the outbound stream behind the guard but still carries the follow
   * camera onto the moving avatar, and says what skipping it costs -- "the body ran off on its
   * spline while the orbit stayed at the pose the controller last wrote, which reads as the view
   * detaching into free flight" (`samples/benilla/crates/benilla-app/src/player.rs:827-886`). Two
   * copies of this block would be two things to keep in step.
   */
  private seatFollowCamera(player: Player, delta: number) {
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

    // First person: hide the body once the fade reaches zero.
    if (player.model) {
      player.model.visible = this.rig.selfFadeAlpha > 0.01;
    }
  }

  render() {
    return <div className="controls" />;
  }
}

export default Controls;
