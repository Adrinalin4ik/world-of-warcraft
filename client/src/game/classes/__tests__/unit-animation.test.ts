/**
 * jsdom, not node: `classes/unit` reaches the debug panel, which touches `window`.
 *
 * (The `cache-manager` singleton this comment used to also name is gone -- it was a dead stub that
 * opened an IndexedDB and did nothing, deleted when the real asset cache landed in
 * `game/net/asset-cache.ts`. Measured after the deletion: this file still fails under `node` with
 * `ReferenceError: window is not defined` in `Unit#engaged`, so the jsdom requirement is real and
 * survives on the debug panel alone.)
 *
 * @jest-environment jsdom
 */
import * as THREE from 'three';
import Unit from '../unit';
import { InstanceAnim } from '../../pipeline/m2/anim/instance-anim';
import { ModelAnim } from '../../pipeline/m2/anim/model-anim';
import { worldClock } from '../../pipeline/m2/anim/world-clock';
import { DEFAULT_MOVE_SPEEDS } from '../../movement/net-motion';

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
    // Part of the arming decision since the masked upper-body route landed: `setAnimation` consults
    // these first. They decline on these doubles (no bones, so no split key-bone) without reading
    // flags -- but they have to be PRESENT, because a method missing from a `.call()` double is a
    // `TypeError` and not a falsy read.
    tryMaskedRoute: (Unit as any).prototype.tryMaskedRoute,
    combatFastPath: (Unit as any).prototype.combatFastPath,
    liveCombatSlot: (Unit as any).prototype.liveCombatSlot,
    tryTransplantUp: (Unit as any).prototype.tryTransplantUp,
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

  /**
   * THE MIRROR of the release-side bug the locomotion task already fixed, and the reason both sites
   * now share `windowElapsedOrInstant`.
   *
   * A ZERO-LENGTH one-shot has `periodMs = 0`, and `windowElapsed` answers FALSE for that for ever
   * (deliberately -- see its doc). So `setAnimation`'s bare `!inst.windowElapsed(...)` swallowed
   * every re-request after the first: the clip could be played once and never again for the life of
   * the model, silently. Degenerate zero-length sequences occur in shipped data.
   *
   * MUTATION KILLED: reverting this site to `inst.windowElapsed(worldClock.ms)`, and equally any
   * "fix" that folds the instant case into `windowElapsed` itself (which would make `cycleDoodad`
   * re-arm a zero-length doodad sequence every frame off the shared rng -- covered separately in
   * `variation-cycle.test.ts`).
   *
   * The clock is advanced first so `armedAtMs` genuinely differs: an assertion against an
   * unadvanced clock would pass on a mutant that never re-armed at all.
   */
  it('replays a zero-length one-shot rather than swallowing the request for ever', () => {
    const u = unit([animation({ id: 15, flags: ONE_SHOT, length: 0 })]);

    u.setAnimation(15);
    const first = u.model.instanceAnim.armedAtMs;
    expect(u.model.instanceAnim.current.id).toBe(15);
    // The window this site used to wait on, which can never elapse.
    expect(u.model.instanceAnim.windowElapsed(worldClock.ms)).toBe(false);

    worldClock.advance(0.4);
    u.setAnimation(15);

    expect(u.model.instanceAnim.armedAtMs).toBe(worldClock.ms);
    expect(u.model.instanceAnim.armedAtMs).not.toBe(first);
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

  // `view.position` and `position` are the SAME vector, as they are on a real Unit (`get position()`
  // returns `this._view.position`). `teleportTo` writes through both names.
  const pos = new THREE.Vector3();

  const u: any = {
    isPlayer,
    wireDriven: false,
    move: {
      swimming: false, swimStrokeSpeed: 0, moveFlags: 0,
      horizVel: new THREE.Vector3(), pos: new THREE.Vector3(),
    },
    speeds: { ...DEFAULT_MOVE_SPEEDS },
    remoteMotion: null,
    splineRide: null,
    locoPrevFlags: 0,
    view: { position: pos, rotation: {} },
    position: pos,
    model: { modelAnim, instanceAnim },
    currentAnimationId: 0,
    locoPrevX: 0,
    locoPrevY: 0,
    locoTracking: false,
    externalSeq: null,
    locoCandidates: null,
    locoTarget: 0,
    locoSeq: null,
    locoMergeVersion: -1,
    emitted: [] as any[],
    emit(...args: any[]) { u.emitted.push(args); },
    setAnimation: proto.setAnimation,
    startAnimation: proto.startAnimation,
    // Part of the arming decision since the masked upper-body route landed -- see the other double.
    tryMaskedRoute: proto.tryMaskedRoute,
    combatFastPath: proto.combatFastPath,
    liveCombatSlot: proto.liveCombatSlot,
    tryTransplantUp: proto.tryTransplantUp,
    deferredOneShot: null,
    locomotionSpeed: proto.locomotionSpeed,
    locomotionFlags: proto.locomotionFlags,
    gaitCandidates: proto.gaitCandidates,
    locomotionRate: proto.locomotionRate,
    updateLocomotion: proto.updateLocomotion,
    teleportTo: proto.teleportTo,
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
   * twice the unit's own walk speed. The reference pins exactly these three points
   * (`creature_anim/select/tests.rs:46-63`): 4.9 Walk, 5.0 Walk, 5.1 Run.
   */
  it('puts the run boundary strictly above twice the walk speed', () => {
    // `gaitCandidates` reads `this.speeds.walk`, so the receiver carries the same default speed set
    // a real Unit is constructed with.
    const self = { speeds: { ...DEFAULT_MOVE_SPEEDS } };
    const gait = (speed: number, flags = 0) =>
      (Unit as any).prototype.gaitCandidates.call(self, flags, speed)[0];

    expect(gait(4.9)).toBe(4);
    expect(gait(5.0)).toBe(4);
    expect(gait(5.1)).toBe(5);

    // And the standing epsilon, likewise a `<=`: a near-zero residual is not a walk.
    expect(gait(0.1)).toBe(0);
    expect(gait(0.11)).toBe(4);
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
   * Kills: ignoring the swim latch. While swimming the mover's `horizVel` is only the HORIZONTAL
   * component of a 3D stroke (`movement/swim.ts:256-258` really does write it), so it understates
   * the gait whenever the swimmer is pitched. The reference reads `swim_stroke_speed` instead
   * (`player.rs:1209-1213`).
   *
   * The fixture is the state the mover actually produces: a 7 yd/s stroke pitched down about 73
   * degrees leaves `horizVel` at 2 yd/s. A mutant reading `horizVel` picks Walk (4); the correct
   * code picks Run (5). Both are non-zero, so the test cannot pass by accident on a Stand default.
   */
  it('uses the swim stroke speed, not horizVel, for a swimming player', () => {
    const u = locoUnit(gaits());
    u.move.swimming = true;
    u.move.swimStrokeSpeed = 7;
    u.move.horizVel.set(2, 0, 0);

    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(5);
  });

  /**
   * IMPORTANT 2. Kills: running locomotion for a wire-driven peer.
   *
   * A peer's `view.position` advances only on the frames a `movement` message lands, so
   * differencing it every frame alternates between "no displacement" (Stand) and "a whole batch in
   * one delta" (above `TELEPORT_SPEED`, also Stand), with real gaits in between. This replays that
   * cadence exactly: two quiet frames, then a catch-up. A mutant that drops the `wireDriven` gate
   * re-arms on the flips -- `armedAtMs` moves and the cursor is pinned near zero, which is the
   * freeze this whole task exists to prevent.
   *
   * The wire's own `setAnimation` must be all that ever touches the peer.
   */
  it('does not run locomotion for a wire-driven peer', () => {
    const u = locoUnit(gaits(), false);
    u.wireDriven = true;

    // What the wire said: this peer is running.
    u.setAnimation(5);
    const armedAt = u.model.instanceAnim.armedAtMs;

    // Two quiet frames, then a coalesced catch-up of 3 yd in one 16 ms frame (187 yd/s).
    worldClock.advance(0.016);
    u.updateLocomotion(0.016);
    worldClock.advance(0.016);
    u.updateLocomotion(0.016);
    u.view.position.set(3, 0, 0);
    worldClock.advance(0.016);
    u.updateLocomotion(0.016);

    expect(u.model.instanceAnim.current.id).toBe(5);
    expect(u.model.instanceAnim.armedAtMs).toBe(armedAt);
    expect(u.model.instanceAnim.cursor(worldClock.ms)).toBeCloseTo(48);
  });

  /**
   * MINOR. Kills: leaving the displacement baseline in place across a teleport.
   *
   * `TELEPORT_SPEED` only catches a relocation big enough to exceed it. A 1 yd hop in one 16 ms
   * frame is 62.5 yd/s -- under the clamp, and a perfectly plausible sprint. `teleportTo` knows it
   * was not locomotion, so it drops the baseline and the next frame re-seeds instead of measuring.
   */
  it('does not read a short teleport as a gait', () => {
    const u = locoUnit(gaits(), false);

    u.updateLocomotion(0.016);
    expect(u.model.instanceAnim.current.id).toBe(0);

    u.teleportTo(1, 0, 0);
    worldClock.advance(0.016);
    u.updateLocomotion(0.016);

    expect(u.model.instanceAnim.current.id).toBe(0);
  });
});

/**
 * IMPORTANT 1: what an externally-armed animation owns, and for how long.
 *
 * The gait pick runs every frame, so without an ownership rule it replaces anything armed from
 * outside -- the wire handler at `network/entity/entity.ts:52`, `jump()`, and every future SMSG
 * animation -- on the next frame. `Unit#externalSeq` is the thin form of the reference's
 * `Special` / `Mode` states, which likewise outrank the gait (`select.rs:280+`).
 */
describe('Unit#updateLocomotion external-animation ownership', () => {
  /**
   * THE REGRESSION THIS ROUND EXISTS FOR: a corpse must not stand back up.
   *
   * Death (id 1) is a ONE-SHOT, so a plain "hold until the window elapses" rule plays it through
   * and then hands the body to the gait -- Stand -- and the dead unit stands up. That is worse than
   * pre-Task-18 behaviour, where it held its final Death frame for ever.
   *
   * Kills: dropping the `currentAnimationId === DEATH` arm of the release check (the corpse arms
   * Stand at 1.4 s), and dropping the ownership check outright (it stands up at 0.4 s, mid-clip).
   * The reference arms death once and holds it the same way (`driver.rs:351`).
   */
  it('never releases Death, even after its one-shot window elapses', () => {
    const u = locoUnit([...gaits(), animation({ id: 1, flags: ONE_SHOT, length: 1000 })]);

    u.setAnimation(1);
    const armedAt = u.model.instanceAnim.armedAtMs;

    // Still inside the window.
    worldClock.advance(0.4);
    u.updateLocomotion(0.4);
    expect(u.model.instanceAnim.current.id).toBe(1);

    // Well past it. A corpse does not stand up, and does not re-arm either.
    worldClock.advance(1.0);
    u.updateLocomotion(0.4);
    worldClock.advance(1.0);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(1);
    expect(u.model.instanceAnim.armedAtMs).toBe(armedAt);
  });

  /**
   * Kills: releasing a LOOPING externally-armed animation. A dance, a sit, or the `Dead` 6 loop has
   * no window to elapse, so a rule phrased only in terms of `windowElapsed` would hand the body
   * back on the very first frame -- the emote would not survive one frame of being received.
   *
   * The unit is also MOVING here, so a mutant that releases has a Run to arm and the failure is
   * unambiguous rather than a coincidental Stand.
   */
  it('never releases a looping emote armed from outside', () => {
    const u = locoUnit([...gaits(), animation({ id: 60, length: 1000 })]);

    u.setAnimation(60);
    const armedAt = u.model.instanceAnim.armedAtMs;

    u.move.horizVel.set(7, 0, 0);
    worldClock.advance(0.4);
    u.updateLocomotion(0.4);
    worldClock.advance(1.2);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(60);
    expect(u.model.instanceAnim.armedAtMs).toBe(armedAt);
    // And it is genuinely LOOPING, not frozen: 1.6 s into a 1 s loop is cursor 600.
    expect(u.model.instanceAnim.cursor(worldClock.ms)).toBeCloseTo(600);
  });

  /**
   * The release side, which matters as much as the hold: an attack swing or a jump must give the
   * body back when it finishes, or the unit is stranded on its end pose for ever.
   *
   * Kills: holding every one-shot unconditionally (the unit never returns to Run), and dropping the
   * hold entirely (the swing is stomped at 0.4 s, mid-clip, and no one-shot is ever visible).
   */
/**
   * A CLAMP ARMED AS A HOLD FREEZES INSTEAD OF RELEASING -- the kneel that must last the whole cast.
   *
   * The owner, opening a quest container: "проигрывается анимация лута, долю секунды, потом он встает".
   * `Opening`'s precast pose is `Loot` (50), an authored clamp rather than a loop, so the latch's window
   * elapsed and handed the body back. The reference holds the same clip with `RepeatAnimation::Never`
   * plus "a deliberate freeze -- no window either" (`creature_anim/driver/mode.rs:523-527`).
   *
   * The test beside this one is the reason `holdClamped` is an explicit argument: keying the freeze off
   * `repetitions < 0` made EVERY one-shot hold, because that parameter defaults to -1. So this asserts
   * the pair -- held with the flag, released without it -- since the whole risk here is a gate that is
   * too broad.
   */
  it('freezes a clamped pose past its window when the caller asks, and only then', () => {
    const held = locoUnit([...gaits(), animation({ id: 50, flags: ONE_SHOT, length: 500 })]);
    held.setAnimation(50, true, -1, true);
    held.move.horizVel.set(7, 0, 0);
    // Well past the 500 ms clip: a plain one-shot would have gone back to the gait by now.
    worldClock.advance(2.0);
    held.updateLocomotion(0.4);
    expect(held.model.instanceAnim.current.id).toBe(50);

    const free = locoUnit([...gaits(), animation({ id: 50, flags: ONE_SHOT, length: 500 })]);
    free.setAnimation(50, true, -1);
    free.move.horizVel.set(7, 0, 0);
    worldClock.advance(2.0);
    free.updateLocomotion(0.4);
    expect(free.model.instanceAnim.current.id).toBe(5);
  });

  it('holds a non-Death one-shot for its window, then releases to the gait', () => {
    const u = locoUnit([...gaits(), animation({ id: 16, flags: ONE_SHOT, length: 1000 })]);

    u.setAnimation(16);
    const armedAt = u.model.instanceAnim.armedAtMs;

    u.move.horizVel.set(7, 0, 0);
    worldClock.advance(0.4);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(16);
    expect(u.model.instanceAnim.armedAtMs).toBe(armedAt);

    // 1.4 s in: past the 1000 ms window, so the gait takes the body back.
    worldClock.advance(1.0);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(5);
  });

  /**
   * Kills: latching ownership on a `setAnimation` that never actually armed anything.
   *
   * A request for an id whose every sequence is external resolves to null and arms nothing, but it
   * still records `currentAnimationId`. If ownership latched on the REQUEST rather than on what is
   * armed, the unit would be suppressed for ever and never animate again.
   */
  it('releases when the external request armed nothing at all', () => {
    // Every sequence external, so `resolve` returns null and nothing is ever armed.
    const u = locoUnit([animation({ id: 0, flags: 0 }), animation({ id: 1, flags: 0 })]);

    u.setAnimation(1);
    expect(u.model.instanceAnim.current).toBeNull();
    // Nothing armed means nothing to own -- the latch is set by the ARM, not by the request.
    expect(u.externalSeq).toBeNull();

    u.move.horizVel.set(7, 0, 0);
    worldClock.advance(0.4);
    expect(() => u.updateLocomotion(0.4)).not.toThrow();

    expect(u.externalSeq).toBeNull();
  });

  /**
   * Kills: treating EVERY external request as a state that owns the body.
   *
   * A gait id is a gait request, not a state, whoever sent it -- and the peer handler and the
   * server both send Stand routinely. Stand is a LOOP, and a looping owner never releases, so a
   * mutant without `isGaitId` latches on the first wire Stand and the unit stands still for the
   * rest of the session however far it walks. It arms Run here; the mutant stays on Stand.
   */
  it('does not take ownership when the wire sends a gait id', () => {
    const u = locoUnit(gaits());

    u.setAnimation(0);
    expect(u.externalSeq).toBeNull();

    u.move.horizVel.set(7, 0, 0);
    worldClock.advance(0.4);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(5);
  });

  /**
   * ROUND-2 IMPORTANT 1, and the common case the previous test did NOT cover.
   *
   * `resolve` falls back to the first inline sequence -- normally Stand, a LOOP -- for any id the
   * model does not own, and most models own few state ids. Latching on the REQUEST rather than on
   * what was ARMED therefore hands ownership of a looping Stand to a state that never arrived, and
   * a looping owner never releases: the unit stands still for the rest of the session.
   *
   * Kills: latching in `setAnimation` off the id (`externalAnimation = !isGaitId(id)`), and any
   * latch that omits the `seq.id === id` test. Both leave the unit on Stand; the correct code walks
   * away at Run. The distinction is only visible with the unit MOVING, which is why it runs.
   */
  it('does not take ownership when the requested state fell back to Stand', () => {
    // Id 55 is absent, so `setAnimation(55)` resolves to slot 0 -- Stand, a loop.
    const u = locoUnit(gaits());

    u.setAnimation(55);
    expect(u.model.instanceAnim.current.id).toBe(0);
    expect(u.externalSeq).toBeNull();

    u.move.horizVel.set(7, 0, 0);
    worldClock.advance(0.4);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(5);
  });

  /**
   * ROUND-2 IMPORTANT 2. `InstanceAnim#windowElapsed` returns FALSE when `periodMs <= 0`, so a
   * zero-length non-looping state never elapses and a release rule phrased only in terms of
   * `windowElapsed` never fires -- the same permanent freeze by a different route. Degenerate
   * zero-length sequences do occur in shipped data (`Rabbit.m2`'s only sequence is one).
   *
   * Kills: dropping the `owner.lengthMs > 0` guard from the release check. The unit holds the
   * zero-length swing for ever; the correct code releases on the next frame and runs.
   */
  it('releases a zero-length external one-shot instead of freezing on it', () => {
    const u = locoUnit([...gaits(), animation({ id: 16, flags: ONE_SHOT, length: 0 })]);

    u.setAnimation(16);
    expect(u.model.instanceAnim.current.id).toBe(16);
    expect(u.model.instanceAnim.windowElapsed(worldClock.ms)).toBe(false);

    u.move.horizVel.set(7, 0, 0);
    worldClock.advance(0.4);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current.id).toBe(5);
    expect(u.externalSeq).toBeNull();
  });

  /**
   * The reason the latch holds a SEQUENCE rather than a boolean: it goes stale by itself when the
   * thing it points at is no longer what is playing, with no bookkeeping at the other end.
   *
   * The reachable case is a MODEL SWAP, which is normal for a unit -- `set displayId` streams a new
   * M2 and the `model` setter installs a fresh `InstanceAnim` whose `current` is null. The latch
   * still points at a sequence belonging to the OLD model's table. Death is the worst version: the
   * setter's replay of `currentAnimationId` cannot arm it if the new model lacks it, so a latch
   * keyed on anything but the live sequence would suppress locomotion on the NEW model for ever.
   *
   * Kills: a boolean latch, or any release rule that does not compare against `inst.current`. The
   * mutant holds Stand on the new model; the correct code notices `inst.current !== owner` and runs.
   */
  it('drops a stale latch when the model is swapped underneath it', () => {
    const u = locoUnit([...gaits(), animation({ id: 1, flags: ONE_SHOT, length: 1000 })]);

    u.setAnimation(1);
    const dead = u.externalSeq;
    expect(dead).not.toBeNull();
    expect(u.model.instanceAnim.current).toBe(dead);

    // A new model streams in. Its instance has never armed, and the latch is now dangling.
    const fresh = locoUnit(gaits());
    u.model = fresh.model;
    expect(u.model.instanceAnim.current).toBeNull();
    expect(u.externalSeq).toBe(dead);

    u.move.horizVel.set(7, 0, 0);
    worldClock.advance(0.4);
    u.updateLocomotion(0.4);

    expect(u.externalSeq).toBeNull();
    expect(u.model.instanceAnim.current.id).toBe(5);
  });
});

describe('Unit#wireDriven lifecycle', () => {
  /**
   * ROUND-2 IMPORTANT 3. `wireDriven` must not latch for life: a creature that took one snapped
   * `MSG_MOVE_*` position before its spline arrived would be locomotion-silent for ever after.
   * A spline IS per-frame motion this client integrates itself, so displacement becomes a real
   * measurement again.
   *
   * Kills: setting `wireDriven` without ever clearing it. The unit stays on Stand; the correct code
   * measures its displacement again and runs.
   */
  it('setSplinePath hands a spline creature back to locomotion', () => {
    const u = locoUnit(gaits(), false);
    u.setSplinePath = (Unit as any).prototype.setSplinePath;
    u.wireDriven = true;

    // Snapped wire position, then a spline takes over.
    u.updateLocomotion(0.016);
    u.setSplinePath([], 0, false);
    expect(u.wireDriven).toBe(false);

    // Now a real, integrated per-frame displacement: 0.16 yd in 16 ms is 10 yd/s.
    u.updateLocomotion(0.016);
    u.view.position.set(0.16, 0, 0);
    worldClock.advance(0.4);
    u.updateLocomotion(0.016);

    expect(u.model.instanceAnim.current.id).toBe(5);
  });
});

describe('Unit#updateLocomotion non-looping gait', () => {
  /**
   * IMPORTANT 4. Kills: gating the arm on sequence identity ALONE (`inst.current === seq`).
   *
   * `setAnimation` deliberately restarts a NON-looping sequence once its window has elapsed. An
   * identity-only outer gate goes behind that and swallows the restart: the one-shot hold returns
   * while the window runs, then the candidate walk resolves the same object and the gate returns,
   * for ever. The clip plays exactly once and freezes on its clamped end pose for as long as the
   * unit keeps moving.
   *
   * Reachable, not theoretical: real wolf sequences carry `0x21` / `0x23` / `0x61`, all of which
   * set bit 0, and `sequenceLoops` is itself still unverified for 3.3.5 (`model-anim.ts:57-58`).
   *
   * The gate is `seq.loops && inst.current === seq`, so a one-shot gait re-arms each time its
   * window elapses and the cycle keeps playing.
   */
  it('re-arms a one-shot gait when its window elapses, instead of freezing on the end pose', () => {
    const u = locoUnit([
      animation({ id: 0 }),
      animation({ id: 5, flags: ONE_SHOT, length: 1000 }),
    ]);

    u.move.horizVel.set(7, 0, 0);
    u.updateLocomotion(0.4);

    const first = u.model.instanceAnim.armedAtMs;
    expect(u.model.instanceAnim.current.id).toBe(5);

    // Mid-window: held, not restarted.
    worldClock.advance(0.4);
    u.updateLocomotion(0.4);
    expect(u.model.instanceAnim.armedAtMs).toBe(first);

    // Past the window: the cycle plays again rather than sticking on the clamped last frame.
    worldClock.advance(0.8);
    u.updateLocomotion(0.4);
    expect(u.model.instanceAnim.current.id).toBe(5);
    expect(u.model.instanceAnim.armedAtMs).toBe(worldClock.ms);
  });

  /**
   * The other half of the same gate: a LOOPING gait must still never be re-armed, however long it
   * runs. Kills: dropping the gate's `inst.current === seq` half, or removing the gate entirely and
   * relying on `setAnimation` while routing through `startAnimation`.
   */
  it('still never re-arms a looping gait', () => {
    const u = locoUnit(gaits());

    u.move.horizVel.set(7, 0, 0);
    u.updateLocomotion(0.4);
    const armedAt = u.model.instanceAnim.armedAtMs;

    for (let i = 0; i < 4; ++i) {
      worldClock.advance(0.4);
      u.updateLocomotion(0.4);
    }

    expect(u.model.instanceAnim.armedAtMs).toBe(armedAt);
    // 1.6 s into a 1 s loop: cursor 600, and deliberately not 1000 (the WRAP boundary reads 0).
    expect(u.model.instanceAnim.cursor(worldClock.ms)).toBeCloseTo(600);
  });
});

/**
 * The gait memo across an external `.anim` merge.
 *
 * `resolve` returns DIFFERENT ANSWERS before and after a merge -- that is the entire point of
 * `mergeExternal` -- but the memo was keyed on the candidate-list reference alone. The bone fixture
 * carries the `timestampsRef` / `valuesRef` pair a real merge re-reads, and its merged first key is
 * `[7, 0, 0]` rather than the origin, so nothing here can pass by sampling bind pose.
 */
describe('Unit#updateLocomotion across an external merge', () => {
  /** Every sequence quarantined (`flags: 0`), so `resolve` returns null until the merge lands. */
  const externalOnlyAnimations = () => [animation({ id: 0, flags: 0, length: 1000 })];

  const externalBone = () => ({
    parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
    translation: {
      interpolationType: 1, globalSequenceID: -1, valueTypeName: 'float32array3',
      tracks: [{
        animationIndex: 0, timestamps: [3197923783], values: [[9, 9, 9]],
        timestampsRef: { count: 2, offset: 0 }, valuesRef: { count: 2, offset: 8 },
      }],
    },
    rotation: { interpolationType: 1, globalSequenceID: -1, tracks: [] },
    scaling: { interpolationType: 1, globalSequenceID: -1, tracks: [] },
  });

  const payload = () => {
    const buffer = new ArrayBuffer(32);
    const view = new DataView(buffer);
    view.setUint32(0, 0, true);
    view.setUint32(4, 1000, true);
    [7, 0, 0, 8, 1, 2].forEach((v, i) => view.setFloat32(8 + i * 4, v, true));
    return buffer;
  };

  /** `locoUnit`, but with a real bone so `mergeExternal` has something to splice into. */
  function mergeableUnit() {
    const u = locoUnit(gaits());
    const modelAnim = new ModelAnim({
      animations: externalOnlyAnimations(),
      sequences: [],
      bones: [externalBone()],
    } as any);
    u.model = { modelAnim, instanceAnim: new InstanceAnim(modelAnim) };
    // `set model` is a real setter on `Unit` and this fixture is a plain object, so reset the memo
    // by hand exactly as the setter does.
    u.locoCandidates = null;
    u.locoSeq = null;
    u.locoMergeVersion = -1;
    return u;
  }

  /**
   * THE PERMANENT FREEZE. A creature with NO inline sequence memoises `locoSeq = null` on its first
   * Stand frame and, being stationary, never changes gait bucket -- so a memo keyed on the
   * candidate list alone never re-resolves, and the unit stands in bind pose for the rest of the
   * session with correct merged keys in the table beside it. This is the identical bug class
   * `InstanceAnim#armable` already killed by storing a version instead of a boolean.
   *
   * MUTATION KILLED: dropping `|| mergeVersion !== this.locoMergeVersion` from the memo gate. The
   * mutant leaves `inst.current` null for ever; the correct code arms Stand on the next frame.
   *
   * The unit is deliberately STATIONARY -- a moving one self-heals at the next gait change, which
   * is exactly why the stationary case is the one that had to be tested.
   */
  it('re-resolves a memoised miss once the merge lands, without a gait change', () => {
    const u = mergeableUnit();

    u.updateLocomotion(0.4);
    expect(u.model.instanceAnim.current).toBeNull();
    // The miss is memoised: the candidate list is now recorded, so a list-keyed memo is closed.
    expect(u.locoCandidates).not.toBeNull();
    expect(u.locoSeq).toBeNull();

    expect(u.model.modelAnim.mergeExternal(u.model.modelAnim.sequences[0], payload())).toBe(true);

    worldClock.advance(0.4);
    u.updateLocomotion(0.4);

    expect(u.model.instanceAnim.current).not.toBeNull();
    expect(u.model.instanceAnim.current.id).toBe(0);
  });

  /**
   * The other half: the memo must still HOLD while nothing has merged, or every unit pays a full
   * linear scan of its sequence table per candidate every frame -- which is the cost the memo
   * exists to avoid, and this branch is what a naive "just always re-resolve" fix would destroy.
   *
   * MUTATION KILLED: removing the memo gate entirely (`if (true)`), and re-stamping
   * `locoMergeVersion` outside the recompute branch in a way that makes the compare vacuous.
   * `resolve` is spied on: it is called for the first frame's walk and never again.
   */
  it('still skips the candidate walk on frames where nothing merged', () => {
    const u = locoUnit(gaits());
    const spy = jest.spyOn(u.model.modelAnim, 'resolve');

    u.updateLocomotion(0.4);
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    for (let f = 0; f < 5; ++f) {
      worldClock.advance(0.4);
      u.updateLocomotion(0.4);
    }

    expect(spy.mock.calls.length).toBe(afterFirst);
    spy.mockRestore();
  });
});

/**
 * The VICTIM's end of the engagement bracket -- the one thing a unit test can hold that a live capture
 * could not be made to reproduce twice (see this round's report: the defect was captured on a real
 * fight, the fix was not).
 */
describe('Unit#engaged', () => {
  /**
   * Kills the one-sided condition: `inCombat` alone, which is written from `SMSG_ATTACKSTART` keyed by
   * the ATTACKER, so a unit being swung at scored false and the gait cascade gave it the relaxed Stand.
   * Also kills a boolean `attackedBy`, which would drop the guard on the first of three wolves to stop.
   */
  it('follows both ends of the attack bracket and clears on death', () => {
    const u = new Unit('0x59ab');
    expect(u.engaged).toBe(false);

    // Being swung at by two attackers, neither of which we answer.
    u.attackedBy.add('0xwolf1');
    u.attackedBy.add('0xwolf2');
    expect(u.engaged).toBe(true);

    u.attackedBy.delete('0xwolf1');
    expect(u.engaged).toBe(true); // the second wolf is still on us
    u.attackedBy.delete('0xwolf2');
    expect(u.engaged).toBe(false);

    // And our own swing, the end that already worked.
    u.inCombat = true;
    expect(u.engaged).toBe(true);

    // A corpse is in no fight at either end.
    u.setDead(true);
    expect(u.engaged).toBe(false);
  });
});
