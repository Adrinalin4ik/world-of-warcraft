/**
 * jsdom, not node: importing `classes/unit` reaches the debug panel and `cache-manager`, whose
 * module-level singleton touches `window.indexedDB` at import time.
 *
 * @jest-environment jsdom
 */
import * as THREE from 'three';
import Unit from '../unit';
import { InstanceAnim } from '../../pipeline/m2/anim/instance-anim';
import { ModelAnim } from '../../pipeline/m2/anim/model-anim';
import { worldClock } from '../../pipeline/m2/anim/world-clock';

/**
 * `0x20` = "keyframes are inline in this .m2", as wolf Stand/Walk/Run really carry.
 *
 * Every fixture here needs it: `ModelAnim` quarantines a sequence without it, because an external
 * sequence's blocks parse as noise off the wrong buffer (`hasInlineData`). It does not touch bit 0,
 * so no clock law moves.
 */
const INLINE = 0x20;

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: INLINE, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

/** `flags` bit 0 SET means a one-shot; clear means it loops (`sequenceLoops`). */
const ONE_SHOT = INLINE | 0x01;

/**
 * `setAnimation` / `startAnimation` called on the prototype against a hand-built `this`.
 *
 * `new Unit(guid)` builds three.js geometry, a raycaster and a collider and registers with the
 * collision world, none of which the arming decision involves.
 */
function unit(animations: any[]) {
  const modelAnim = new ModelAnim({ animations, sequences: [], bones: [] });
  const instanceAnim = new InstanceAnim(modelAnim);

  const u: any = {
    model: { modelAnim, instanceAnim },
    currentAnimationId: 0,
    emitted: [] as any[],
    emit(...args: any[]) { u.emitted.push(args); },
    setAnimation: (Unit as any).prototype.setAnimation,
    startAnimation: (Unit as any).prototype.startAnimation,
  };

  return u;
}

beforeEach(() => worldClock.reset());

describe('Unit#setAnimation re-entry guard', () => {
  /**
   * Kills: arming unconditionally on every call -- which is what the pre-Task-16 stub did.
   *
  * The peer handler at `network/entity/entity.ts:52` reaches this entry point directly, with
   * whatever `interrupt` the wire carried, and can repeat an id it already sent. `InstanceAnim` is
   * clock-indexed off `armedAtMs`, so re-arming each frame pins the cursor at zero and the model
   * stands on the first keyframe of its run cycle for the whole run. The guard must hold in spite
   * of `interrupt` for a looping sequence.
   */
  it('does not re-arm a loop that is already running, even with interrupt set', () => {
    const u = unit([animation({ id: 2 })]);

    u.setAnimation(2, true);
    const armedAt = u.model.instanceAnim.armedAtMs;

    worldClock.advance(0.4);
    u.setAnimation(2, true);
    worldClock.advance(0.4);
    u.setAnimation(2, true);

    expect(u.model.instanceAnim.armedAtMs).toBe(armedAt);
    // Which is the point: the cursor has actually advanced through the run cycle.
    expect(u.model.instanceAnim.cursor(worldClock.ms)).toBeCloseTo(800);
  });

  /** Kills: guarding so hard that a genuine animation CHANGE is swallowed too. */
  it('re-arms when a different animation is requested', () => {
    const u = unit([animation({ id: 2 }), animation({ id: 133 })]);

    u.setAnimation(2);
    worldClock.advance(0.4);
    u.setAnimation(133);

    expect(u.model.instanceAnim.current.id).toBe(133);
    expect(u.model.instanceAnim.armedAtMs).toBe(worldClock.ms);
    expect(u.currentAnimationId).toBe(133);
  });

  /**
   * Kills: applying the loop guard to one-shots as well, which would leave a jump or an attack
   * playable exactly once and then dead for the rest of the session.
   */
  it('restarts a one-shot whose play window has elapsed', () => {
    const u = unit([animation({ id: 15, flags: ONE_SHOT, length: 1000 })]);

    u.setAnimation(15);
    worldClock.advance(1.5);
    u.setAnimation(15);

    expect(u.model.instanceAnim.armedAtMs).toBe(worldClock.ms);
  });

  /** Kills: ignoring `interrupt`, which is what re-triggers a one-shot still mid-play. */
  it('leaves a one-shot mid-window alone unless interrupted', () => {
    const u = unit([animation({ id: 15, flags: ONE_SHOT, length: 1000 })]);

    u.setAnimation(15);
    const armedAt = u.model.instanceAnim.armedAtMs;

    worldClock.advance(0.3);
    u.setAnimation(15, false);
    expect(u.model.instanceAnim.armedAtMs).toBe(armedAt);

    u.setAnimation(15, true);
    expect(u.model.instanceAnim.armedAtMs).toBe(worldClock.ms);
  });
});

describe('Unit#startAnimation resolution', () => {
  /**
   * Kills: indexing `modelAnim.sequences` with the requested id instead of going through
   * `resolve()`. The ids in `Unit`'s `Animation` enum are `AnimationData.dbc` ids (133 = backward),
   * not table slots; a raw index into a two-sequence table is `undefined` and the unit freezes in
   * bind pose. `resolve` falls back to sequence 0 -- Stand -- instead.
   */
  it('falls back to sequence 0 for an animation the model does not own', () => {
    const u = unit([animation({ id: 0 }), animation({ id: 2 })]);

    u.startAnimation(133, -1);

    expect(u.model.instanceAnim.current).not.toBeNull();
    expect(u.model.instanceAnim.current.index).toBe(0);
  });

  /**
   * `resolve` now returns null for a model whose every sequence is EXTERNAL -- its keyframes live
   * in a sibling `.anim` file and what the parser read off the `.m2` buffer is noise
   * (`model-anim.ts#hasInlineData`). This is what `unit.ts`'s `if (!seq) return;` promises, and it
   * is reachable in normal play: `unit.ts` arms whatever id the SMSG handler sends.
   *
   * Kills: an exit gate in `resolve` that can never return null, and a `startAnimation` that
   * dereferences the result before checking it. Also pins that `currentAnimationId` is still
   * recorded -- Task 20 merges the real data later, and the model setter replays that id, so
   * dropping it here would leave the unit silently stuck on Stand for ever afterwards.
   */
  it('does not arm a model whose every sequence is external, but still records the request', () => {
    const u = unit([animation({ id: 0, flags: 0 }), animation({ id: 15, flags: 0 })]);

    expect(u.model.modelAnim.resolve(15)).toBeNull();
    expect(() => u.startAnimation(15, -1)).not.toThrow();

    expect(u.model.instanceAnim.current).toBeNull();
    expect(u.emitted).toHaveLength(0);

    // `setAnimation` records BEFORE the resolve, so a later merge can replay it.
    u.setAnimation(15);
    expect(u.currentAnimationId).toBe(15);
  });

  /** Kills: dereferencing a null `instanceAnim` -- true for every model that animates nothing. */
  it('does nothing for a model with no instance', () => {
    const u = unit([animation()]);
    u.model.instanceAnim = null;

    expect(() => u.startAnimation(0, -1)).not.toThrow();
    expect(u.emitted).toHaveLength(0);
  });

  /** Kills: dereferencing a model that has not streamed in yet. */
  it('does nothing before a model has loaded', () => {
    const u = unit([animation()]);
    u.model = null;

    expect(() => u.setAnimation(0)).not.toThrow();
  });

  /**
   * Kills: the early `if (!this.model) return;` dropping the request on the floor.
   *
   * Spawn and animation packets routinely arrive ahead of the async M2 load, so this is the normal
   * case for a unit streaming in, not an edge one. The id has to be RECORDED even though it cannot
   * be armed, because the `model` setter replays `currentAnimationId` when the load lands. Returning
   * first left the unit standing on Stand with nothing to explain why.
   */
  it('records an animation requested before the model has loaded, for the setter to replay', () => {
    const u = unit([animation({ id: 0 }), animation({ id: 15 })]);
    const pending = u.model;
    u.model = null;

    u.setAnimation(15);
    expect(u.currentAnimationId).toBe(15);

    // What `set model` does once the load resolves.
    u.model = pending;
    u.startAnimation(u.currentAnimationId, -1);

    expect(u.model.instanceAnim.current.id).toBe(15);
  });
});

/**
 * `Unit#updateLocomotion` -- the gait driver, called once per unit per frame from
 * `World#animateEntities`.
 *
 * Fixtures use `length: 1000` and sample at 400 / 800 ms, NEVER at exactly 1000: `cursorMs(WRAP,
 * 1000, 1000)` is `0`, which is indistinguishable from an instance that was just re-armed -- the
 * exact bug these tests exist to catch.
 */
function locoUnit(animations: any[], isPlayer: boolean = true) {
  const modelAnim = new ModelAnim({ animations, sequences: [], bones: [] });
  const instanceAnim = new InstanceAnim(modelAnim);

  const proto: any = (Unit as any).prototype;
  const u: any = {
    isPlayer,
    move: { swimming: false, swimStrokeSpeed: 0, horizVel: new THREE.Vector3() },
    view: { position: new THREE.Vector3() },
    model: { modelAnim, instanceAnim },
    currentAnimationId: 0,
    locoPrevX: 0,
    locoPrevY: 0,
    locoTracking: false,
    emitted: [] as any[],
    emit(...args: any[]) { u.emitted.push(args); },
    setAnimation: proto.setAnimation,
    startAnimation: proto.startAnimation,
    locomotionSpeed: proto.locomotionSpeed,
    gaitFor: proto.gaitFor,
    updateLocomotion: proto.updateLocomotion,
  };

  return u;
}

/** Stand / Walk / Run, all inline (`0x20`), as wolf and kobold really carry them. */
const gaits = () => [
  animation({ id: 0 }), animation({ id: 4 }), animation({ id: 5 }),
];

describe('Unit#updateLocomotion gait selection', () => {
  /**
   * Kills: arming unconditionally each frame instead of only on a gait CHANGE -- verified against
   * the mutant that drops the `inst.current === seq` gate AND routes to `startAnimation`, which is
   * what "arm every frame" actually looks like here. (Dropping the gate alone still passes, because
   * `setAnimation`'s own loop guard catches it: the two are layered on purpose, and this test pins
   * the layer, not one line of it.)
   *
   * This is the failure the whole design is shaped around -- a re-armed loop's cursor is pinned at
   * zero -- so the assertion is not just `armedAtMs` but that the cursor has genuinely walked to
   * 800 ms. A re-arming mutant leaves it at 0 and fails on both counts.
   */
  it('arms Stand once for a stationary unit and does not re-arm it', () => {
    const u = locoUnit(gaits());

    u.updateLocomotion(0.4);
    const armedAt = u.model.instanceAnim.armedAtMs;
    expect(u.model.instanceAnim.current.id).toBe(0);

    worldClock.advance(0.4);
    u.updateLocomotion(0.4);
    worldClock.advance(0.4);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.armedAtMs).toBe(armedAt);
    expect(u.model.instanceAnim.cursor(worldClock.ms)).toBeCloseTo(800);
  });

  /**
   * Kills: treating any non-zero speed as Run (the `GAIT_STAND` / threshold mutants), and
   * re-arming Walk every frame while walking (same unguarded-arm mutant as above).
   *
   * 3.0 yd/s is above `MOVING_EPSILON` and below the 5.0 run boundary. Crossing zero must arm Walk
   * exactly once; the cursor then has to advance, or the walk cycle is a freeze-frame.
   */
  it('arms Walk exactly once when speed crosses zero', () => {
    const u = locoUnit(gaits());

    u.updateLocomotion(0.4);
    expect(u.model.instanceAnim.current.id).toBe(0);

    u.move.horizVel.set(3, 0, 0);
    worldClock.advance(0.4);
    u.updateLocomotion(0.4);

    const armedAt = u.model.instanceAnim.armedAtMs;
    expect(u.model.instanceAnim.current.id).toBe(4);
    expect(u.currentAnimationId).toBe(4);

    worldClock.advance(0.4);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.armedAtMs).toBe(armedAt);
    expect(u.model.instanceAnim.cursor(worldClock.ms)).toBeCloseTo(400);
  });

  /** Kills: never selecting Run at all -- a unit that only ever walks. */
  it('arms Run above the run threshold', () => {
    const u = locoUnit(gaits());

    u.move.horizVel.set(7, 0, 0);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(5);
  });

  /**
   * Kills: `>=` in place of `>` on the run boundary, and a boundary at any value other than
   * `2 x DEFAULT_WALK_SPEED`. The reference pins exactly these three points
   * (`creature_anim/select/tests.rs:46-63`): 4.9 Walk, 5.0 Walk, 5.1 Run.
   */
  it('puts the run boundary strictly above twice the walk speed', () => {
    expect((Unit as any).prototype.gaitFor.call({}, 4.9)[0]).toBe(4);
    expect((Unit as any).prototype.gaitFor.call({}, 5.0)[0]).toBe(4);
    expect((Unit as any).prototype.gaitFor.call({}, 5.1)[0]).toBe(5);

    // And the standing epsilon, likewise a `<=`: a near-zero residual is not a walk.
    expect((Unit as any).prototype.gaitFor.call({}, 0.1)[0]).toBe(0);
    expect((Unit as any).prototype.gaitFor.call({}, 0.11)[0]).toBe(4);
  });

  /**
   * THE TRAP TASK 16 FLAGGED, asserted directly: the idle branch of the old `updateMoving` was
   * commented out, so a unit that stopped kept whatever it was last given.
   *
   * Kills: any implementation with no stand branch -- it leaves the unit on Run for ever and this
   * fails on the id. Also kills a stand branch that fails to re-arm on the transition, since
   * `armedAtMs` must be the moment of the stop, not the moment the run started.
   */
  it('arms Stand again when a running unit stops', () => {
    const u = locoUnit(gaits());

    u.move.horizVel.set(7, 0, 0);
    u.updateLocomotion(0.4);
    expect(u.model.instanceAnim.current.id).toBe(5);

    worldClock.advance(0.4);
    u.move.horizVel.set(0, 0, 0);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(0);
    expect(u.currentAnimationId).toBe(0);
    expect(u.model.instanceAnim.armedAtMs).toBe(worldClock.ms);
  });

  /**
   * Kills: handing the top candidate straight to `resolve` and accepting whatever comes back.
   *
   * `resolve` falls back to sequence 0 and NOTHING ELSE, so `resolve(5)` on a model that only walks
   * returns Stand -- a creature sliding across the ground at running speed. The candidate list has
   * to step Run -> Walk itself. A fixture with Walk present but Run absent is the only shape that
   * separates the two behaviours: the mutant arms id 0, the correct code arms id 4.
   */
  it('steps Run down to Walk for a model that has no Run', () => {
    const u = locoUnit([animation({ id: 0 }), animation({ id: 4 })]);

    u.move.horizVel.set(7, 0, 0);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(4);
    expect(u.currentAnimationId).toBe(4);
  });

  /**
   * Kills: throwing, or arming nothing, for a model whose table is Stand alone -- `Rabbit.m2`, the
   * one model fixture in this repo, is exactly that. It must fall through `resolve` to Stand rather
   * than freeze in bind pose.
   */
  it('falls back to Stand for a model with no gait clips at all', () => {
    const u = locoUnit([animation({ id: 0 })]);

    u.move.horizVel.set(3, 0, 0);
    expect(() => u.updateLocomotion(0.4)).not.toThrow();

    expect(u.model.instanceAnim.current).not.toBeNull();
    expect(u.model.instanceAnim.current.index).toBe(0);
  });

  /** Kills: dereferencing a model that has not streamed in yet, on a path that runs every frame. */
  it('does nothing before a model has loaded', () => {
    const u = locoUnit(gaits());
    u.model = null;

    expect(() => u.updateLocomotion(0.4)).not.toThrow();
  });
});

describe('Unit#updateLocomotion speed source', () => {
  /**
   * Kills: reading `move.horizVel` for every unit. Nothing writes it for a non-player -- the spline
   * follower and the peer handler both set `view.position` outright -- so a mutant that uses it
   * reads a permanent zero and every creature in the world stands still while it slides.
   *
   * 0.16 yd in 0.016 s is 10 yd/s, unambiguously Run. The first frame must be Stand: there is no
   * previous position to difference against.
   */
  it('measures a non-player unit from its displacement', () => {
    const u = locoUnit(gaits(), false);

    u.updateLocomotion(0.016);
    expect(u.model.instanceAnim.current.id).toBe(0);

    u.view.position.set(0.16, 0, 0);
    worldClock.advance(0.4);
    u.updateLocomotion(0.016);

    expect(u.model.instanceAnim.current.id).toBe(5);
  });

  /**
   * Kills: dropping the teleport clamp. A worldport moves a unit hundreds of yards in one frame;
   * without the clamp it flashes into its run cycle on arrival. 50 yd in 0.016 s is 3125 yd/s.
   */
  it('reads a teleport-sized jump as standing, not sprinting', () => {
    const u = locoUnit(gaits(), false);

    u.updateLocomotion(0.016);
    u.view.position.set(50, 0, 0);
    worldClock.advance(0.4);
    u.updateLocomotion(0.016);

    expect(u.model.instanceAnim.current.id).toBe(0);
  });

  /**
   * Kills: ignoring the swim latch. While swimming the mover's `horizVel` is the 3D stroke's
   * horizontal component and understates the gait; the reference reads `swim_stroke_speed`
   * (`player.rs:1209-1213`). Here `horizVel` is left at zero and only the stroke speed is set, so a
   * mutant reading `horizVel` stands still mid-swim.
   */
  it('uses the swim stroke speed for a swimming player', () => {
    const u = locoUnit(gaits());
    u.move.swimming = true;
    u.move.swimStrokeSpeed = 7;

    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(5);
  });
});

describe('Unit#updateLocomotion one-shot hold', () => {
  /**
   * Kills: letting the per-frame gait pick stomp a playing one-shot. Without the hold, a jump is
   * overwritten on the very next frame and no one-shot in the game is ever visible for more than
   * ~16 ms. The release side matters just as much: a hold with no expiry would strand the unit on
   * the jump pose for ever.
   */
  it('holds a one-shot inside its window, then releases to the gait', () => {
    const u = locoUnit([...gaits(), animation({ id: 15, flags: ONE_SHOT, length: 1000 })]);

    u.setAnimation(15);
    const armedAt = u.model.instanceAnim.armedAtMs;

    u.move.horizVel.set(7, 0, 0);
    worldClock.advance(0.4);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(15);
    expect(u.model.instanceAnim.armedAtMs).toBe(armedAt);

    // 1.4 s in: past the 1000 ms window, so the gait takes the body back.
    worldClock.advance(1.0);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(5);
  });
});
