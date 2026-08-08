import * as THREE from 'three';
import {
  DEFAULT_MOVE_SPEEDS,
  MoveFlag,
  advanceRemote,
  applyRemoteMove,
  createRemoteMotion,
} from '../net-motion';

/**
 * The defect this file exists for, reproduced as the sender actually behaves.
 *
 * A peer walking forward puts a `MSG_MOVE_SET_FACING` on the wire on every frame his facing changes
 * and a `MSG_MOVE_HEARTBEAT` only when nothing else went out for 500 ms
 * (`network/game/object/player/movement.ts:450,461`). So his packets arrive in bursts ~33 ms apart
 * separated by ~500 ms of silence -- and the interpolator this replaced sized its window from the
 * PREVIOUS gap, so it emptied in 80 ms and then stood still for the rest of the 500 ms.
 *
 * The assertion is therefore not "it is smooth" but the two halves of the report separately: no
 * frame stands still, and no frame rushes.
 */
it('dead-reckons a walking peer with no stall and no rush across a burst-then-silence cadence', () => {
  const motion = createRemoteMotion();
  const out = new THREE.Vector3();
  const dt = 1 / 60;
  const speeds = DEFAULT_MOVE_SPEEDS;

  // He starts running forward, facing +X, at the origin.
  applyRemoteMove(motion, { x: 0, y: 0, z: 0, facing: 0, flags: MoveFlag.FORWARD }, 0);

  const speedsSeen: number[] = [];
  let nowMs = 0;
  // 1.5 s: three 500 ms heartbeat periods, each opened by a three-packet facing burst 33 ms apart.
  for (let frame = 0; frame < 90; ++frame) {
    const before = motion.pos.clone();
    advanceRemote(motion, speeds, dt, out);
    speedsSeen.push(before.distanceTo(motion.pos) / dt);

    nowMs += dt * 1000;
    const intoPeriod = nowMs % 500;
    // The sender's own timeline: he is where his flags say he is, which after `t` seconds of running
    // forward from the origin is `run * t` along +X. That is the packet the server relays.
    const burst = intoPeriod < 100 || intoPeriod > 495;
    if (burst) {
      applyRemoteMove(
        motion,
        { x: (speeds.run * nowMs) / 1000, y: 0, z: 0, facing: 0, flags: MoveFlag.FORWARD },
        nowMs,
      );
    }
  }

  const min = Math.min(...speedsSeen);
  const max = Math.max(...speedsSeen);

  // No stall: every frame moves him. The old scheme produced whole runs of exact zeros here.
  expect(min).toBeGreaterThan(speeds.run * 0.99);
  // No rush: nothing ever exceeds the speed his own flags picked.
  expect(max).toBeLessThan(speeds.run * 1.01);
});

/**
 * The gait input, which is the other half of the same defect: the animation stalled WITH the motion
 * because the selector read a measured displacement. It reads `motion.speed` now, and that is the
 * speed the flags picked -- so a `/walk`-toggled peer is a walk and a stopped peer is a stand, with
 * no dependence on packet cadence at all.
 */
it('reports the flag-chosen speed as the gait speed', () => {
  const motion = createRemoteMotion();
  const out = new THREE.Vector3();

  applyRemoteMove(motion, { x: 0, y: 0, z: 0, facing: 0, flags: MoveFlag.FORWARD }, 0);
  advanceRemote(motion, DEFAULT_MOVE_SPEEDS, 1 / 60, out);
  expect(motion.speed).toBeCloseTo(DEFAULT_MOVE_SPEEDS.run, 5);

  applyRemoteMove(
    motion,
    { x: 0, y: 0, z: 0, facing: 0, flags: MoveFlag.FORWARD | MoveFlag.WALK_MODE },
    100,
  );
  advanceRemote(motion, DEFAULT_MOVE_SPEEDS, 1 / 60, out);
  expect(motion.speed).toBeCloseTo(DEFAULT_MOVE_SPEEDS.walk, 5);

  applyRemoteMove(motion, { x: 0, y: 0, z: 0, facing: 0, flags: 0 }, 200);
  advanceRemote(motion, DEFAULT_MOVE_SPEEDS, 1 / 60, out);
  expect(motion.speed).toBe(0);
});
