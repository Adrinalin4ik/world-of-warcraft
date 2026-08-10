/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { DEFAULT_COLLISION_HEIGHT, GRAVITY } from '../constants';
import { createPlayerMoveState } from '../player-state';
import {
  capRedirect, restCap, settleToRest, SWIM_JUMP_SPEED, SWIM_SPEED, swimEnterDepth, swimExitDepth,
  updateSwimming,
} from '../swim';

/**
 * Ported from the reference's own suite (`player/swim.rs`), Z-up.
 *
 * This suite is unusually valuable because it encodes defects that were expensive to find: the
 * gnome who cannot surface, the river that flaps the latch ten times a second, the dolphin hop that
 * re-latches while still rising.
 */

/**
 * The shipped `CreatureModelData.collisionHeight x displayScale` for three real bodies. Human male
 * is the one a single constant happened to match -- 2.031 against 2.0278, 2 mm apart -- which is
 * why the gnome defect hid for so long.
 */
const HUMAN_MALE = 2.031;
const GNOME_FEMALE = 1.150; // 1.000 column x 1.15 display scale
const NIGHT_ELF_MALE = 2.438;

function playerOfHeight(z: number, h: number) {
  const player = createPlayerMoveState();
  player.pos.set(0, 0, z);
  player.collisionHeight = h;
  return player;
}

const playerAt = (z: number) => playerOfHeight(z, HUMAN_MALE);

describe('the swim depth latch', () => {
  it('has the verified 1/36 yd hysteresis at every body height', () => {
    for (const h of [HUMAN_MALE, GNOME_FEMALE, NIGHT_ELF_MALE]) {
      // The band is exactly 1/36 yd, INDEPENDENT of height -- so it is subtracted, never scaled.
      expect(swimEnterDepth(h) - swimExitDepth(h)).toBeCloseTo(1 / 36, 9);
      expect(swimEnterDepth(h)).toBeCloseTo(0.75 * h, 9);
    }
  });

  it('enters strictly past the threshold and leaves below the band', () => {
    const enter = swimEnterDepth(HUMAN_MALE);
    const exit = swimExitDepth(HUMAN_MALE);
    const midBand = (enter + exit) * 0.5;
    const player = playerAt(0); // feet at 0, so the surface height IS the submersion depth

    expect(updateSwimming(player, enter, 0)).toBe(false);       // exactly at enter: strict >
    expect(updateSwimming(player, midBand, 0)).toBe(false);     // in band from walking: walks
    expect(updateSwimming(player, enter + 0.01, 0)).toBe(true);
    expect(updateSwimming(player, midBand, 0)).toBe(true);      // same depth from swimming: holds
    expect(updateSwimming(player, exit - 0.01, 0)).toBe(false);
  });

  it('stops swimming when there is no liquid, regardless of depth history', () => {
    const player = playerAt(0);
    expect(updateSwimming(player, swimEnterDepth(HUMAN_MALE) + 0.5, 0)).toBe(true);
    expect(updateSwimming(player, null, 0)).toBe(false);
  });

  it('leaves the settle hold alone', () => {
    // The settle release belongs to world residency, in every mover mode alike. A swim latch that
    // cleared it here would race that judgement.
    for (const surface of [swimEnterDepth(HUMAN_MALE) + 1, swimExitDepth(HUMAN_MALE) - 0.5, null]) {
      const player = playerAt(0);
      player.settling = true;
      updateSwimming(player, surface, 0);

      expect(player.settling).toBe(true);
    }
  });
});

describe('levitating', () => {
  it('bails the water decision in BOTH directions', () => {
    // GM flight is the SUPPRESSION, not a lift. Dry land cannot clear a server-granted swim -- which
    // is what keeps you airborne -- and deep water cannot grant one. Same instruction, both arms.
    const flying = playerAt(0);
    flying.swimming = true;
    flying.levitating = true;

    expect(updateSwimming(flying, null, 0)).toBe(true);
    expect(updateSwimming(flying, -50, 0)).toBe(true);

    const dry = playerAt(0);
    dry.levitating = true;
    expect(updateSwimming(dry, swimEnterDepth(HUMAN_MALE) + 1, 0)).toBe(false);
  });

  it('hands the water its job back once cleared', () => {
    const player = playerAt(0);
    player.swimming = true;
    player.levitating = true;
    updateSwimming(player, null, 0);

    player.levitating = false;
    expect(updateSwimming(player, null, 0)).toBe(false);
  });
});

describe('the fall re-entry gate', () => {
  it('re-latches the hop at half launch velocity, while still rising', () => {
    // A fresh swim jump is not re-latched until its upward velocity has decayed to HALF the launch
    // value. The release happens while STILL RISING, which is what tops the dolphin hop at ~1.6 yd
    // rather than at the full ballistic apex.
    const halfDecay = SWIM_JUMP_SPEED / (2 * GRAVITY);
    const deep = swimEnterDepth(HUMAN_MALE) + 1;

    const player = playerAt(0);
    player.airborneSince = 0;
    player.jumpZSpeed = SWIM_JUMP_SPEED;
    player.velZ = SWIM_JUMP_SPEED;
    expect(updateSwimming(player, deep, halfDecay * 0.5)).toBe(false);

    player.velZ = SWIM_JUMP_SPEED * 0.49;
    expect(updateSwimming(player, deep, halfDecay + 1e-3)).toBe(true);
  });

  it('lets a plain fall into water enter regardless of the clock', () => {
    const player = playerAt(0);
    player.airborneSince = 0;
    player.jumpZSpeed = SWIM_JUMP_SPEED;
    player.velZ = -0.1;

    expect(updateSwimming(player, swimEnterDepth(HUMAN_MALE) + 1, 0.01)).toBe(true);
  });
});

describe('the rest line', () => {
  it('is satisfied from above and never pulls up', () => {
    for (const h of [HUMAN_MALE, GNOME_FEMALE, NIGHT_ELF_MALE]) {
      const cap = restCap(h);

      expect(settleToRest(10 - cap, 10, h)).toBeCloseTo(0, 9);          // on the line
      expect(settleToRest(10 - cap - 0.01, 10, h)).toBeCloseTo(0, 9);   // a dive: no pull up
      expect(settleToRest(10 - cap - 30, 10, h)).toBeCloseTo(0, 9);     // deep: still none
      expect(settleToRest(10 - cap + 0.25, 10, h)).toBeCloseTo(0.25, 9); // above: sink the excess
    }
  });

  it('floats every race with its head out of the water', () => {
    // The rest line is 0.75*h below the waterline, so the head clears it iff 0.75*h < h --
    // trivially true for the unit's OWN h, and false the moment one body's h is used for another's.
    for (const h of [HUMAN_MALE, GNOME_FEMALE, NIGHT_ELF_MALE]) {
      const submerged = restCap(h);

      expect(submerged).toBeLessThan(h);
      expect((h - submerged) / h).toBeCloseTo(0.25, 6);
    }
  });

  it('shows the shape of the gnome defect a single constant produces', () => {
    // One human-sized constant puts the rest line ABOVE a gnome's head, so she is held under with
    // water to spare and no stroke can reach the surface -- the cap is a hard collision plane and
    // the resolver has no upward force but the cap.
    const oneConstant = restCap(DEFAULT_COLLISION_HEIGHT);

    expect(oneConstant).toBeGreaterThan(GNOME_FEMALE);
    expect(oneConstant - GNOME_FEMALE).toBeGreaterThan(0.3);
  });

  it('does not flap the latch under a descending surface', () => {
    // The downhill-river jitter, as the frame loop that produces it. The slope is a real measured
    // river channel.
    const SLOPE = 0.099;
    const DT = 1 / 60;
    const H = HUMAN_MALE;
    const cap = restCap(H);
    const surfaceAfter = (secs: number) => 100 - SLOPE * SWIM_SPEED * secs;

    // (a) Frozen feet -- the pre-fix law. The surface descends through the whole 1/36 yd band
    // almost at once, and every crossing hands the avatar to the fall mover and back.
    const frozen = playerOfHeight(surfaceAfter(0) - cap, H);
    frozen.swimming = true;
    let leftAt: number | null = null;
    for (let i = 0; i < 600; ++i) {
      const t = i * DT;
      if (!updateSwimming(frozen, surfaceAfter(t), t)) {
        leftAt = t;
        break;
      }
    }

    expect(leftAt).not.toBeNull();
    expect(leftAt!).toBeLessThan(0.1);

    // (b) The shipped law: the settle runs on the surface at the position the stroke reached.
    const held = playerOfHeight(surfaceAfter(0) - cap, H);
    held.swimming = true;
    for (let i = 0; i < 600; ++i) {
      const t = i * DT;
      const surface = surfaceAfter(t);
      held.pos.z -= settleToRest(held.pos.z, surface, H);

      expect(updateSwimming(held, surface, t)).toBe(true);
      expect(surface - held.pos.z - cap).toBeCloseTo(0, 4);
    }
  });
});

describe('capRedirect', () => {
  const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  it('leaves a free stroke untouched', () => {
    const free = v3(0.1, 0.2, 3);

    expect(capRedirect(free, 100).surfacePitch).toBeNull();
    expect(capRedirect(free, Infinity).surfacePitch).toBeNull();
  });

  it('never touches a dive', () => {
    expect(capRedirect(v3(1, 0, -2), 0).surfacePitch).toBeNull();
  });

  it('turns a steep stroke pinned at the line into full-speed LEVEL swimming', () => {
    // A plain clip would leave cos(pitch) * speed -- about zero -- which is the invisible wall.
    const steep = v3(0.08, 0, 4.72);
    const pinned = capRedirect(steep, 0);

    expect(pinned.velocity.length()).toBeCloseTo(steep.length(), 4);
    expect(pinned.velocity.z).toBeCloseTo(0, 9);
    expect(pinned.velocity.x).toBeGreaterThan(4.7);
    expect(pinned.surfacePitch).toBeCloseTo(0, 6);
  });

  it('preserves speed and eases the pitch while approaching the line', () => {
    const steep = v3(0.08, 0, 4.72);
    const partial = capRedirect(steep, 2);
    const aim = Math.atan2(steep.z, steep.x);

    expect(partial.velocity.length()).toBeCloseTo(steep.length(), 4);
    expect(partial.velocity.z).toBeCloseTo(2, 6);
    expect(partial.surfacePitch!).toBeGreaterThan(0);
    expect(partial.surfacePitch!).toBeLessThan(aim);
  });

  it('preserves speed at every cap between pinned and free', () => {
    const steep = v3(1, 1, 4);
    for (const cap of [0, 0.5, 1, 2, 3, 3.9]) {
      expect(capRedirect(steep, cap).velocity.length()).toBeCloseTo(steep.length(), 4);
    }
  });
});
