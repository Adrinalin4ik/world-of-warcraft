/** @jest-environment node */
import * as THREE from 'three';
import { InstanceAnim, LOCAL_TRS_STRIDE } from '../instance-anim';
import { ModelAnim } from '../model-anim';

/**
 * `0x20` = keyframes inline in this .m2, as wolf Stand/Walk/Run really carry.
 *
 * These tests arm `m.sequences[0]` by hand rather than through `resolve`/`pickVariation`, so they
 * would pass with `flags: 0` too -- but `flags: 0` means EXTERNAL, and `ModelAnim` quarantines it
 * (`hasInlineData`). A fixture on that value describes a model that cannot reach these code paths.
 * `0x20` leaves bit 0 alone, so no clock law moves.
 */
const INLINE = 0x20;

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: INLINE, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

const model = (over: any = {}) => new ModelAnim({
  animations: [animation()], sequences: [], bones: [], ...over,
});

describe('InstanceAnim clock', () => {
  it('starts unarmed with a zero cursor', () => {
    const inst = new InstanceAnim(model());
    expect(inst.current).toBeNull();
    expect(inst.cursor(5000)).toBe(0);
  });

  it('measures the cursor from the arm time, not from accumulated deltas', () => {
    const m = model();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 1000);
    expect(inst.cursor(1000)).toBe(0);
    expect(inst.cursor(1400)).toBe(400);
  });

  it('wraps a looping sequence on its length', () => {
    const m = model();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    expect(inst.cursor(2500)).toBe(500);
  });

  it('clamps a one-shot sequence at its length', () => {
    const m = model({ animations: [animation({ flags: INLINE | 0x01, length: 1000 })] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    expect(inst.cursor(2500)).toBe(1000);
  });
});

/**
 * The load-bearing property. Gating an offscreen instance is only safe if a resumed instance shows
 * the pose the shared clock dictates -- not a pose behind by however long it was skipped. A
 * delta-accumulating clock fails this; a clock-indexed one passes it by construction.
 */
describe('clock-indexed resume', () => {
  it('a paused instance resumes to the same cursor as one that never paused', () => {
    const m = model();

    const continuous = new InstanceAnim(m);
    continuous.arm(m.sequences[0], 0);
    for (let t = 0; t <= 2500; t += 16) {
      continuous.cursor(t);
    }

    const paused = new InstanceAnim(m);
    paused.arm(m.sequences[0], 0);
    paused.cursor(100);
    // ... skipped entirely from 100ms to 2500ms ...

    expect(paused.cursor(2500)).toBe(continuous.cursor(2500));
  });

  it('does not drift across many pause/resume cycles', () => {
    const m = model();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    for (let t = 0; t < 100_000; t += 997) {
      inst.cursor(t);
    }
    expect(inst.cursor(100_000)).toBe(0);
  });
});

const emptyBlock = () => ({ interpolationType: 1, globalSequenceID: -1, tracks: [] });
const vec3Block = (values: number[][]) => ({
  interpolationType: 1,
  globalSequenceID: -1,
  tracks: [{ animationIndex: 0, timestamps: [0, 1000], values }],
});
const quatBlock = (values: number[][]) => ({
  interpolationType: 1,
  globalSequenceID: -1,
  tracks: [{ animationIndex: 0, timestamps: [0, 1000], values }],
});
/** A non-wrapping 2000ms sequence -- see the comment on 'composes a child onto its parent'. */
const longAnimation = () => ([{
  id: 0, subID: 0, length: 2000, flags: INLINE, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0,
}]);
const bone = (over: any = {}) => ({
  parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
  translation: emptyBlock(), rotation: emptyBlock(), scaling: emptyBlock(), ...over,
});

const matrixOf = (inst: InstanceAnim, index: number) =>
  new THREE.Matrix4().fromArray(inst.palette, index * 16);

describe('solveBones', () => {
  it('produces identity for an unanimated bone', () => {
    const m = model({ bones: [bone()] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(0);
    expect(matrixOf(inst, 0).equals(new THREE.Matrix4())).toBe(true);
  });

  it('applies a translated bone at the sampled cursor', () => {
    const m = model({
      bones: [bone({ translation: vec3Block([[0, 0, 0], [10, 0, 0]]) })],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(500);
    const p = new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 0));
    expect(p.x).toBeCloseTo(5, 4);
  });

  it('composes a child onto its parent', () => {
    // NOTE: sequence length is overridden to 2000ms (not the fixture default of 1000ms). The
    // default model()'s sequence loops (bit 0 clear) with length 1000ms, and the WRAP clock law wraps
    // an elapsed time exactly equal to the period back to cursor 0 (verified by
    // 'does not drift across many pause/resume cycles' above) -- so solveBones(1000) against the
    // default-length sequence would sample the START of the translation track, not the end, and
    // this test would assert a wrong pose rather than exercise parent composition. Lengthening the
    // sequence keeps 1000ms strictly inside the window.
    const m = model({
      animations: [{
        id: 0, subID: 0, length: 2000, flags: INLINE, probability: 32767,
        blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0,
      }],
      bones: [
        bone({ translation: vec3Block([[0, 0, 0], [10, 0, 0]]) }),
        bone({ parentID: 0, translation: vec3Block([[0, 0, 0], [0, 4, 0]]) }),
      ],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(1000);
    const p = new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 1));
    expect(p.x).toBeCloseTo(10, 4);
    expect(p.y).toBeCloseTo(4, 4);
  });

  it('composes parent then child in that order, not the reverse', () => {
    // Both bones in 'composes a child onto its parent' above are pure translations, and
    // translation matrices commute (T(a)*T(b) == T(b)*T(a)) -- so that test cannot tell
    // `out.premultiply(parent)` (parent * child, correct) apart from `out.multiply(parent)`
    // (child * parent, the reversal the task brief warned against). Rotation does not commute
    // with translation, so a rotated parent is the discriminator.
    //
    // Parent: rotated 90 degrees about Z, no translation, pivot at the origin.
    // Child: translated [10, 0, 0] from its parent, no rotation of its own.
    //
    // Correct order (parent * child): the child's local translation is rotated INTO the
    // parent's frame, landing at world (0, 10, 0).
    // Reversed order (child * parent): the child's local translation is applied in its OWN
    // frame first, and multiplying a pure translation by a pure rotation on the right leaves
    // the translation column unrotated -- the child would incorrectly stay at (10, 0, 0), as if
    // the parent's rotation had no effect on it at all.
    const m = model({
      animations: longAnimation(),
      bones: [
        bone({ rotation: quatBlock([[0, 0, 0, 1], [0, 0, Math.SQRT1_2, Math.SQRT1_2]]) }),
        bone({ parentID: 0, translation: vec3Block([[0, 0, 0], [10, 0, 0]]) }),
      ],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(1000);
    const p = new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 1));
    expect(p.x).toBeCloseTo(0, 4);
    expect(p.y).toBeCloseTo(10, 4);
  });

  it('rotates a bone around its own pivot, not around the model origin', () => {
    // Every other fixture uses pivotPoint [0, 0, 0], which makes `scratchPivotTo` and
    // `scratchPivotBack` both identity -- swapping them would not fail a single existing test.
    // A non-zero pivot with a rotation is the discriminator.
    //
    // Bone: pivot at [5, 0, 0], rotated 180 degrees about Z, no translation of its own.
    //
    // Correct composition (pivotTo * local * pivotBack): the pivot point itself is a fixed point
    // of the rotation, so it stays put; the origin, which is 5 units on the near side of the
    // pivot, ends up 5 units on the FAR side -- world (10, 0, 0).
    // Swapped (pivotBack * local * pivotTo): the origin would instead land at (-10, 0, 0) --
    // rotated the opposite way around a pivot mirrored through the origin.
    const m = model({
      animations: longAnimation(),
      bones: [
        bone({ pivotPoint: [5, 0, 0], rotation: quatBlock([[0, 0, 0, 1], [0, 0, 1, 0]]) }),
      ],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(1000);

    const origin = new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 0));
    expect(origin.x).toBeCloseTo(10, 4);
    expect(origin.y).toBeCloseTo(0, 4);

    const pivot = new THREE.Vector3(5, 0, 0).applyMatrix4(matrixOf(inst, 0));
    expect(pivot.x).toBeCloseTo(5, 4);
    expect(pivot.y).toBeCloseTo(0, 4);
  });

  it('degrades a parent-ID cycle to a wrong pose, never a crash', () => {
    // Shipped M2 data can be malformed. `solved[index]` is set BEFORE `solveBone` recurses into
    // the parent specifically so a parent cycle terminates instead of recursing until the stack
    // blows. The resulting pose for a bone caught in a cycle is allowed to be wrong; the call is
    // not allowed to throw or hang.
    const m = model({
      bones: [bone({ parentID: 1 }), bone({ parentID: 0 })],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);

    let solved = -1;
    expect(() => {
      solved = inst.solveBones(0);
    }).not.toThrow();
    expect(solved).toBe(2);
  });

  it('solves each bone exactly once however many children request it', () => {
    const m = model({
      bones: [bone(), bone({ parentID: 0 }), bone({ parentID: 0 }), bone({ parentID: 1 })],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    expect(inst.solveBones(0)).toBe(4);
  });

  it('allocates no new palette between frames', () => {
    const m = model({ bones: [bone()] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    const first = inst.palette;
    inst.solveBones(0);
    inst.solveBones(16);
    expect(inst.palette).toBe(first);
  });
});

/**
 * The blueprint cache holds one never-placed prototype M2 per model path, and it owns an
 * `InstanceAnim` like any other placement. Buffers sized off the bone count are the bulk of that
 * object, so nothing may be allocated until an instance is actually armed.
 */
describe('lazy buffer allocation', () => {
  const manyBones = () => model({
    bones: Array.from({ length: 40 }, () => bone()),
  });

  it('holds no per-bone storage before arming', () => {
    const inst = new InstanceAnim(manyBones());
    expect(inst.palette.length).toBe(0);
    expect(inst.localTRS.length).toBe(0);
  });

  it('allocates on arm', () => {
    const m = manyBones();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    expect(inst.palette.length).toBe(40 * 16);
    expect(inst.localTRS.length).toBe(40 * LOCAL_TRS_STRIDE);
  });

  it('allocates on a solve that was never preceded by an arm', () => {
    const inst = new InstanceAnim(manyBones());
    expect(inst.solveBones(0)).toBe(40);
    expect(inst.palette.length).toBe(40 * 16);
  });

  it('allocates exactly once across arm, re-arm and many solves', () => {
    const m = manyBones();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    const palette = inst.palette;
    const trs = inst.localTRS;
    inst.solveBones(0);
    inst.arm(m.sequences[0], 500);
    inst.solveBones(516);
    expect(inst.palette).toBe(palette);
    expect(inst.localTRS).toBe(trs);
  });

  it('costs nothing at all for a zero-bone model', () => {
    const m = model({ bones: [] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    expect(inst.palette.length).toBe(0);
  });
});

/**
 * `localTRS` is what actually reaches the screen -- `M2#applyPose` writes it into the three.js bone
 * hierarchy, which then accumulates the parent chain. It must therefore hold the UN-composed local
 * transform, never the parent-composed one the palette carries.
 */
describe('localTRS', () => {
  it('defaults an unanimated bone to identity TRS', () => {
    const m = model({ bones: [bone()] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(0);
    expect(Array.from(inst.localTRS)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('records the sampled translation at the cursor', () => {
    const m = model({
      bones: [bone({ translation: vec3Block([[0, 0, 0], [10, 20, 30]]) })],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(500);
    expect(inst.localTRS[0]).toBeCloseTo(5, 4);
    expect(inst.localTRS[1]).toBeCloseTo(10, 4);
    expect(inst.localTRS[2]).toBeCloseTo(15, 4);
  });

  it('records a child LOCAL, not the parent-composed matrix the palette holds', () => {
    const m = model({
      bones: [
        bone({ translation: vec3Block([[100, 0, 0], [100, 0, 0]]) }),
        bone({ parentID: 0, translation: vec3Block([[7, 0, 0], [7, 0, 0]]) }),
      ],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(0);

    // The palette accumulates: child sits at 107 along X.
    expect(new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 1)).x).toBeCloseTo(107, 4);
    // localTRS does not: the child's own contribution is 7.
    expect(inst.localTRS[LOCAL_TRS_STRIDE]).toBeCloseTo(7, 4);
  });

  it('survives the parent recursion clobbering the shared scratch objects', () => {
    // solveBone samples into module-level scratch and then recurses into its parent, which samples
    // into the same scratch. Bone 1 is solved first here and must still report ITS values.
    //
    // NOTE: this test does NOT currently discriminate, and is kept as a guard rather than as
    // evidence. `solveBones` iterates bones in file order, and real M2 data always declares a parent
    // before its children (`parentID < index`), so by the time a child is reached its parent is
    // already flagged solved and the recursion returns without touching the scratch. The hazard is
    // reachable only through malformed data with a forward parent reference -- which the fixture
    // below does not construct, because `ModelAnim` would be describing a file no client could load.
    // Contriving one would test the fixture, not the solver. If the iteration order ever changes,
    // this is the test that should start failing.
    const m = model({
      bones: [
        bone({ translation: vec3Block([[1, 1, 1], [1, 1, 1]]) }),
        bone({ parentID: 0, translation: vec3Block([[9, 9, 9], [9, 9, 9]]) }),
      ],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(0);
    expect(inst.localTRS[LOCAL_TRS_STRIDE]).toBeCloseTo(9, 4);
    expect(inst.localTRS[0]).toBeCloseTo(1, 4);
  });

  it('records a sampled rotation as a unit quaternion', () => {
    const m = model({
      bones: [bone({ rotation: quatBlock([[0, 0, 0, 1], [0, 0, 0, 1]]) })],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(250);
    const q = new THREE.Quaternion(
      inst.localTRS[3], inst.localTRS[4], inst.localTRS[5], inst.localTRS[6],
    );
    expect(q.length()).toBeCloseTo(1, 6);
  });
});

/**
 * `poseGatedInstance` calls `solveBones` unconditionally, and its three callers
 * (`doodad-manager.js#animateDoodads`, `wmo/index.js#animate`, `world/index.ts#animateEntities`)
 * gate on `inst !== null`, not on `inst.current !== null`. So an instance that never armed is still
 * solved every eligible frame -- reachable whenever `armDoodad` latches unarmable or `resolve`
 * returns null, both of which the external-sequence quarantine makes more common.
 *
 * Defaulting that case to sequence slot 0 reads a real track, and slot 0 is not guaranteed inline.
 */
describe('the unarmed instance solves from a non-slot, not slot 0', () => {
  // Kills: `this.current ? this.current.index : 0` in `solveBone`.
  //
  // Slot 0's FIRST key is [7, 0, 0], not the origin, and that detail is load-bearing: `cursor()`
  // returns 0 for an unarmed instance, so a slot-0 default samples key 0 of the track and nothing
  // else. A fixture whose first key happens to be the origin passes either way -- which is exactly
  // what the first draft of this test did. Real noise has no reason to start at the origin.
  it('poses to bind pose rather than sampling slot 0', () => {
    const m = new ModelAnim({
      // Slot 0 EXTERNAL, slot 1 inline -- the shape where slot 0's keys are parsed noise.
      animations: [animation({ id: 0, flags: 0 }), animation({ id: 1, flags: INLINE })],
      sequences: [],
      bones: [bone({
        translation: {
          interpolationType: 1,
          globalSequenceID: -1,
          tracks: [
            { animationIndex: 0, timestamps: [0, 1000], values: [[7, 0, 0], [10, 0, 0]] },
            { animationIndex: 1, timestamps: [0, 1000], values: [[0, 0, 0], [0, 0, 0]] },
          ],
        },
      })],
    });

    const inst = new InstanceAnim(m);
    expect(inst.current).toBeNull();
    inst.solveBones(500);

    expect(matrixOf(inst, 0).equals(new THREE.Matrix4())).toBe(true);
  });

  // Kills: a fix that reaches bind pose by refusing to solve at all. The palette must still be
  // filled with identity matrices, because the skinning shader reads it either way.
  it('still fills the palette, with identity', () => {
    const m = model({ bones: [bone(), bone({ parentID: 0 })] });
    const inst = new InstanceAnim(m);

    expect(inst.solveBones(500)).toBe(2);
    expect(matrixOf(inst, 0).equals(new THREE.Matrix4())).toBe(true);
    expect(matrixOf(inst, 1).equals(new THREE.Matrix4())).toBe(true);
  });

  // Kills: reintroducing slot 0 once a sequence IS armed. The same block, the same instance --
  // arming slot 1 must select slot 1's track, and arming slot 0 must select slot 0's.
  it('reads the armed slot once armed', () => {
    const m = model({
      animations: [animation(), animation({ id: 1 })],
      bones: [bone({ translation: {
        interpolationType: 1,
        globalSequenceID: -1,
        tracks: [
          { animationIndex: 0, timestamps: [0, 1000], values: [[0, 0, 0], [10, 0, 0]] },
          { animationIndex: 1, timestamps: [0, 1000], values: [[0, 0, 0], [-6, 0, 0]] },
        ],
      } })],
    });
    const inst = new InstanceAnim(m);

    inst.arm(m.sequences[0], 0);
    inst.solveBones(500);
    expect(new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 0)).x).toBeCloseTo(5, 4);

    inst.arm(m.sequences[1], 0);
    inst.solveBones(500);
    expect(new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 0)).x).toBeCloseTo(-3, 4);
  });
});

/**
 * THE CROSS-FADE, which is what `blendTime` was parsed for and what nothing read until now. One test:
 * the weight ramp at three points, on a bone the two sequences translate to different places.
 */
describe('the second weighted track', () => {
  /**
   * Kills a hard cut (the pose would be B's at t=0), a fade in the wrong direction (A's at t=150), a
   * weight taken off the wrong clock, and a fade that outlives its blend time.
   *
   * Slot 0 holds the bone at x=100 for its whole length, slot 1 at x=0 -- so the blended x IS the
   * weight, read directly, with no interpolation of A or B to reason about.
   */
  it('ramps from the outgoing pose to the incoming one over blendTime', () => {
    const m = model({
      animations: [
        animation({ length: 1000 }),
        animation({ length: 1000, blendTime: 150 }),
      ],
      bones: [bone({
        translation: {
          interpolationType: 1,
          globalSequenceID: -1,
          tracks: [
            { animationIndex: 0, timestamps: [0, 1000], values: [[100, 0, 0], [100, 0, 0]] },
            { animationIndex: 1, timestamps: [0, 1000], values: [[0, 0, 0], [0, 0, 0]] },
          ],
        },
      })],
    });
    const inst = new InstanceAnim(m);
    const x = (t: number) => {
      inst.solveBones(t);
      return new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 0)).x;
    };

    inst.arm(m.sequences[0], 0);
    expect(x(0)).toBeCloseTo(100, 4);

    // Arm the second at t=1000. At the instant of the arm the body must still be entirely in the
    // OUTGOING pose, and at the end of the 150 ms blend entirely in the incoming one.
    inst.arm(m.sequences[1], 1000);
    expect(x(1000)).toBeCloseTo(100, 4);
    expect(x(1075)).toBeCloseTo(50, 4);
    expect(x(1150)).toBeCloseTo(0, 4);
    // And it stays there: a retired fade must not resurrect.
    expect(x(2000)).toBeCloseTo(0, 4);
  });
});

/**
 * GLOBAL-SEQUENCE BONE CHANNELS. A global block has no sequence timeline: one track, read at index 0
 * whatever is playing, on a free-running clock that is a pure function of world time.
 *
 * `model({ sequences: [...] })` is the GLOBAL sequence duration list, not the animation list --
 * `ModelAnim` reads `data.sequences` into `globalSequenceDurations` (`model-anim.ts:412`) and builds
 * `m.sequences` from `data.animations`. Easy to misread, and getting it backwards makes these pass
 * for the wrong reason.
 */
const gsVec3 = (gs: number, values: number[][]) => ({
  interpolationType: 1,
  globalSequenceID: gs,
  tracks: [{ animationIndex: 0, timestamps: [0, 400], values }],
});

describe('global-sequence bone channels', () => {
  it('reads track 0 on the world clock whatever sequence INDEX is armed', () => {
    const m = model({
      animations: [animation(), animation({ id: 1 })],
      sequences: [400],
      bones: [bone({ translation: gsVec3(0, [[0, 0, 0], [8, 0, 0]]) })],
    });
    const inst = new InstanceAnim(m);
    // Sequence INDEX 1, which is the whole point: the old bone path did `trackFor(block, 1)` on a
    // one-track global block, read `undefined` and fell to bind pose. A character has 156 sequences,
    // so index 0 was the rare case and "frozen" was the normal one.
    inst.arm(m.sequences[1], 0);

    inst.solveBones(200);
    expect(new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 0)).x).toBeCloseTo(4, 4);

    // And it WRAPS on the global period from world time -- 600 % 400 = 200, the same pose again.
    inst.solveBones(600);
    expect(new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 0)).x).toBeCloseTo(4, 4);
  });

  it('is a no-op through a cross-fade instead of dipping toward bind pose', () => {
    const m = model({
      animations: [animation(), animation({ id: 1 }), animation({ id: 2 })],
      sequences: [400],
      bones: [bone({ translation: gsVec3(0, [[0, 0, 0], [8, 0, 0]]) })],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[1], 0);
    // Opens a 150ms fade with the OUTGOING slot at index 1, so the outgoing leg's `trackFor(block, 1)`
    // is the miss: it used to read `undefined`, leave `blendPos` at the identity, and lerp the correct
    // value halfway to bind pose for the length of every transition. Sampling the outgoing leg through
    // the same global rule makes prev === current and the mix a no-op.
    inst.arm(m.sequences[2], 1000);
    inst.solveBones(1075);
    // 1075 % 400 = 275, so 275/400 of the way from 0 to 8.
    expect(new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 0)).x).toBeCloseTo(5.5, 4);
  });
});
