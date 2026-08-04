/**
 * jsdom, not node: importing `classes/unit` reaches the debug panel and `cache-manager`, whose
 * module-level singleton touches `window.indexedDB` at import time.
 *
 * @jest-environment jsdom
 */
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
   * `Unit#updateMoving` WOULD call `setAnimation(Animation.forward, true)` once per FRAME for as
   * long as the key is held -- it has no caller today (locomotion is unwired; see the task report),
   * so this pins a LATENT hazard rather than a live one. `InstanceAnim` is clock-indexed off
   * `armedAtMs`, so re-arming each frame pins the cursor at zero and the model stands on the first
   * keyframe of its run cycle for the whole run. Note `interrupt` is `true` at that call site, so
   * the guard must hold in spite of it for a looping sequence.
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
