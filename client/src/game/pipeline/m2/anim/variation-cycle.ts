import { InstanceAnim } from './instance-anim';

/** The doodad arming animation id: Stand. */
const DOODAD_ANIM_ID = 0;

/**
 * The client's single global `rand()` stream -- the MSVC LCG at `0x7400e5`, returning `[0, 32767]`
 * (benilla `doodad_anim.rs:31-35`).
 *
 * ONE shared stream, drawn consecutively, is what de-syncs a stand of identical props. It is
 * deliberately NOT a per-placement seed: benilla shipped a position-derived hash first, and while
 * it de-synced instances correctly it did so PERMANENTLY -- the same placement rolled the same
 * variation on every re-stream and every run, so the Blasted Lands lightning struck from one fixed
 * spot for ever instead of wandering.
 *
 * Seedable only so the tests can be exact; production uses the module singleton.
 */
export class SharedRng {
  private state: number;

  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  reset(seed = 1): void {
    this.state = seed >>> 0;
  }

  /** Next draw in `[0, 32767]`. */
  next(): number {
    // MSVC's LCG: state = state * 214013 + 2531011; result = (state >> 16) & 0x7fff.
    // Math.imul keeps the multiply in 32-bit, which a plain `*` would not.
    this.state = (Math.imul(this.state, 214013) + 2531011) >>> 0;
    return (this.state >>> 16) & 0x7fff;
  }
}

/** The one stream every doodad draws from. */
export const sharedRng = new SharedRng(1);

/**
 * Arm a doodad's animation, rolling a fresh frequency-weighted variation.
 *
 * A doodad is NOT "animation 0 on loop". Per benilla (`doodad_anim.rs:4-9`) it is armed at bone 0 /
 * animation id 0 / `linkFlag=1`, and then re-arms itself at every play-window boundary for ever,
 * rolling a new variation each time. Global sequences run underneath with no arming at all.
 */
export function armDoodad(
  inst: InstanceAnim,
  worldClockMs: number,
  rng: SharedRng = sharedRng,
): void {
  const seq = inst.model.pickVariation(DOODAD_ANIM_ID, rng.next());
  if (!seq) {
    return;
  }
  inst.arm(seq, worldClockMs);
}

/**
 * Advance the self-sustaining variation cycle. Returns true if it re-armed this call.
 *
 * Gated on RESIDENCY, not on the draw -- the two gates are deliberately different
 * (`doodad_anim.rs:20-25`). A doodad behind the camera keeps cycling variations; it just stops
 * being posed. Because sampling is clock-indexed, that costs nothing and drifts nothing.
 */
export function cycleDoodad(
  inst: InstanceAnim,
  worldClockMs: number,
  rng: SharedRng = sharedRng,
): boolean {
  if (inst.current === null) {
    armDoodad(inst, worldClockMs, rng);
    return inst.current !== null;
  }
  if (!inst.windowElapsed(worldClockMs)) {
    return false;
  }
  armDoodad(inst, worldClockMs, rng);
  return true;
}
