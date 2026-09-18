/** @jest-environment node */
import * as THREE from 'three';
import Unit from '../unit';
import { InstanceAnim } from '../../pipeline/m2/anim/instance-anim';
import { ModelAnim } from '../../pipeline/m2/anim/model-anim';
import { worldClock } from '../../pipeline/m2/anim/world-clock';
import { DEFAULT_MOVE_SPEEDS } from '../../movement/net-motion';

/**
 * **`Unit#baseHeldByLoop` -- the predicate that keeps a hit from destroying a held cast pose.**
 *
 * The owner: "Когда кастую, каждый удар по мне сбивает каст." The cast bar and the wire were both
 * innocent; what a hit destroyed was the POSE, because `combat.ts`' victim flinch is a one-shot over
 * a LOOPING `externalSeq` and `tryMaskedRoute` declines to mask while that latch is held, so the
 * request fell through to the full-body route and replaced a loop that never self-releases.
 *
 * This asserts the one value the fix turns on, and it asserts the DISTINCTION rather than just the
 * true case -- a predicate that answered true for every external owner would also decline the
 * ordinary one-shot-over-one-shot flinch this block exists for.
 *
 * WHICH LAYER: the predicate on a hand-built double with a real `ModelAnim`/`InstanceAnim`, the
 * harness `oneshot-precedence.test.ts` established. It says nothing about the packet path, and
 * nothing about pixels -- whether the caster VISIBLY keeps his pose is the owner's to see.
 */

/** `0x20` = inline keys, loop bit clear; `| 0x01` makes it a one-shot. See `instance-anim.test.ts`. */
const INLINE = 0x20;
const ONE_SHOT = INLINE | 0x01;

const animation = (id: number, flags: number) => ({
  id, subID: 0, length: 1000, flags, probability: 32767,
  blendTime: 0, movementSpeed: 0, nextAnimationID: -1, alias: 0,
});

function unit(animations: any[]) {
  const modelAnim = new ModelAnim({ animations, sequences: [], bones: [] });
  const instanceAnim = new InstanceAnim(modelAnim);
  const proto: any = (Unit as any).prototype;
  const pos = new THREE.Vector3();
  const u: any = {
    isPlayer: true,
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
    locoTracking: true,
    externalSeq: null,
    externalHeld: false,
    locoCandidates: null,
    locoTarget: 0,
    locoSeq: null,
    locoMergeVersion: -1,
    deferredOneShot: null,
    emitted: [] as any[],
    emit(...args: any[]) { u.emitted.push(args); },
    setAnimation: proto.setAnimation,
    startAnimation: proto.startAnimation,
    tryMaskedRoute: proto.tryMaskedRoute,
    combatFastPath: proto.combatFastPath,
    liveCombatSlot: proto.liveCombatSlot,
    tryTransplantUp: proto.tryTransplantUp,
    releaseAnimationLatch: proto.releaseAnimationLatch,
  };
  return u;
}

/** The getter, invoked the way this harness invokes everything else -- through the prototype. */
const heldByLoop = (u: any): boolean => Object
  .getOwnPropertyDescriptor((Unit as any).prototype, 'baseHeldByLoop')!
  .get!.call(u) as boolean;

beforeEach(() => worldClock.reset());

/** 51 is `ReadySpellDirected`, the precast hold (`dbc/entities/spell-visual-kit.js`: kit 30). */
const READY_SPELL = 51;
/** 30 is `Dodge` -- what `defenseAnimation` picks for a dodged swing. */
const DODGE = 30;

it('a held cast pose reads as loop-held, and a plain one-shot does not', () => {
  const u = unit([
    animation(READY_SPELL, INLINE), // a LOOP: the precast hold
    animation(DODGE, ONE_SHOT),
    animation(0, INLINE),
  ]);

  // Nothing armed: the base is the gait's, so a flinch is free to take it.
  expect(heldByLoop(u)).toBe(false);

  // The precast pose lands, as `SMSG_SPELL_START` arms it.
  u.setAnimation(READY_SPELL, true, 0);
  expect(u.model.instanceAnim.current.id).toBe(READY_SPELL);
  // Latched, and latched on a LOOP -- which is the state a flinch must not overwrite, because a
  // looping owner never self-releases and nothing would put the pose back.
  expect(heldByLoop(u)).toBe(true);

  // The cast ends the way `releaseCastPose` ends it, and the base is available again.
  expect(u.releaseAnimationLatch(READY_SPELL)).toBe(true);
  expect(heldByLoop(u)).toBe(false);
});

it('a NON-looping external owner is not loop-held, so an ordinary flinch still plays', () => {
  // The distinction that keeps the fix narrow: a one-shot owner releases itself when its window
  // elapses, so a flinch over it costs a moment of one clip rather than a pose held for ever. If the
  // guard tested `animationLatchId !== null` instead, this case would wrongly decline too.
  const u = unit([animation(DODGE, ONE_SHOT), animation(16, ONE_SHOT), animation(0, INLINE)]);

  u.setAnimation(16, true, 0);
  expect(u.model.instanceAnim.current.id).toBe(16);
  expect(heldByLoop(u)).toBe(false);
});
