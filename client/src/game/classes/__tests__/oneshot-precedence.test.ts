/** @jest-environment node */
import * as THREE from 'three';
import Unit from '../unit';
import { InstanceAnim } from '../../pipeline/m2/anim/instance-anim';
import { ModelAnim } from '../../pipeline/m2/anim/model-anim';
import { worldClock } from '../../pipeline/m2/anim/world-clock';
import { DEFAULT_MOVE_SPEEDS, MoveFlag } from '../../movement/net-motion';

/** `0x20` = inline keys, loop bit clear. `| 0x01` makes it a one-shot. See `instance-anim.test.ts`. */
const INLINE = 0x20;
const ONE_SHOT = INLINE | 0x01;

const animation = (id: number, flags: number) => ({
  id, subID: 0, length: 1000, flags, probability: 32767,
  blendTime: 0, movementSpeed: id === 5 ? 7 : 0, nextAnimationID: -1, alias: 0,
});

const emptyBlock = () => ({ interpolationType: 1, globalSequenceID: -1, tracks: [] });
const bone = (over: any = {}) => ({
  parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
  translation: emptyBlock(), rotation: emptyBlock(), scaling: emptyBlock(), ...over,
});

/**
 * The shape of `humanmale.m2`'s split, measured -- see `anim/upper-body.ts`. Bone 2 carries
 * KeyBoneID 4 (SpineLow) and bone 3 its Waist sibling, so bone 4 is "an arm" and bone 5 "a leg".
 */
const SPLIT_RIG = [
  bone(), bone({ parentID: 0, keyBoneID: 26 }), bone({ parentID: 1, keyBoneID: 4 }),
  bone({ parentID: 1, keyBoneID: 5 }), bone({ parentID: 2 }), bone({ parentID: 3 }),
];

function unit(animations: any[], bones: any[]) {
  const modelAnim = new ModelAnim({ animations, sequences: [], bones });
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
    locomotionSpeed: proto.locomotionSpeed,
    locomotionFlags: proto.locomotionFlags,
    gaitCandidates: proto.gaitCandidates,
    locomotionRate: proto.locomotionRate,
    updateLocomotion: proto.updateLocomotion,
  };
  return u;
}

beforeEach(() => worldClock.reset());

/**
 * Kills: cutting a live combat clip with the next auto-attack -- the owner's "Анимация способностей
 * должна быть выше чем анимация автоатаки". The client never hard-cuts one combat clip with another
 * (`driver.rs:864-880`): the live one doubles and the request parks until nothing is playing.
 */
it('parks a swing over a live combat clip, doubles it, and plays the park when it ends', () => {
  const u = unit([animation(17, ONE_SHOT), animation(16, ONE_SHOT), animation(0, INLINE)], []);

  u.setAnimation(17, true, 0);
  expect(u.model.instanceAnim.current.id).toBe(17);

  worldClock.advance(0.4);
  u.setAnimation(16, true, 0);

  // NOT armed: 17 is still what is playing, at double rate, and 16 is parked.
  expect(u.model.instanceAnim.current.id).toBe(17);
  expect(u.model.instanceAnim.playbackRate).toBe(2);
  expect(u.deferredOneShot).toBe(16);

  // 17's window is 1000 ms of clip at 2x from the re-anchor, so it is over well inside a second.
  worldClock.advance(1.0);
  u.updateLocomotion(0.016);

  expect(u.deferredOneShot).toBeNull();
  expect(u.model.instanceAnim.current.id).toBe(16);
});

/**
 * Kills: letting a swing's ownership latch stop the legs -- the owner's "прыжек все еще не работает с
 * атакой". The transplant (`0x5fe919`) moves the live clip onto the torso and hands the base to the
 * gait; standing still it must NOT fire, which is what keeps the confirmed combat bracket.
 */
it('transplants a swing onto the torso when the legs start running, and not while standing', () => {
  const u = unit([animation(5, INLINE), animation(17, ONE_SHOT), animation(0, INLINE)], SPLIT_RIG);

  u.setAnimation(17, true, 0);
  expect(u.model.instanceAnim.current.id).toBe(17);

  // STANDING: the head gait candidate is Stand, which is not a locomotion id, so nothing moves and
  // the swing keeps the whole body -- the Ice Block gate (`driver/mode.rs:318-327`).
  worldClock.advance(0.2);
  u.updateLocomotion(0.016);
  expect(u.model.instanceAnim.overlay).toBeNull();
  expect(u.model.instanceAnim.current.id).toBe(17);
  expect(u.externalSeq).not.toBeNull();

  // RUNNING: head candidate is Run 5, a locomotion id. The swing moves up, the latch releases, and
  // the legs get the gait.
  u.move.moveFlags = MoveFlag.FORWARD;
  u.move.horizVel.set(7, 0, 0);
  worldClock.advance(0.2);
  u.updateLocomotion(0.016);

  expect(u.model.instanceAnim.overlay.id).toBe(17);
  expect(u.model.instanceAnim.current.id).toBe(5);
  expect(u.externalSeq).toBeNull();
});
