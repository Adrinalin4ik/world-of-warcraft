import * as THREE from 'three';

/**
 * THE BILLBOARD LAST-HOP PROBE, and it exists because reading was exhausted.
 *
 * Five candidates for "billboarding is simply absent" on `DemonArmor_Impact_Head` were refuted by
 * inspection -- the live list, the billboard type, the writer's `bone.skin` guard, the pose
 * clobbering the rotation, and `matrixAutoUpdate` making `bone.rotation` inert (this project's own
 * recorded trap). Every one of those is a statement about STATE. None of them observed the value that
 * actually reaches a vertex, and the owner's screenshot shows the shield mesh nearly EDGE-ON.
 *
 * So this measures the last hop. `M2#applyBillboards` writes `bone.rotation`; three's
 * `Skeleton#update` builds the skinning palette from `bone.matrixWorld`. Those are two different
 * places, and the only question that matters is whether the second one MOVES when the camera turns:
 *
 *   writerRotChangeDeg > 0 and paletteRotChangeDeg ~ 0  =>  the billboard never reached the palette.
 *   both ~ 0                                            =>  the writer itself is not running.
 *   both > 0                                            =>  the billboard IS in the palette and the
 *                                                            defect is further downstream still.
 *
 * TWO READS THAT DO NOT DIFFER IS THE PROOF, which is why every row carries `frames`: a row whose
 * counter has not advanced between two console reads is a stale sample and its deltas mean nothing.
 * This project has voided four measurement arms on exactly that, and the rule it settled on was
 * "existence at boot proves nothing; ticking at the moment of use is the only test that has held".
 *
 * EVERY FIELD NAME SAYS WHICH OF THE TWO IT HOLDS. `writer*` is the bone's own quaternion straight
 * after `applyBillboards`; `palette*` is decomposed from `bone.matrixWorld`, i.e. what skinning
 * reads. A field called `rotation` would be exactly the ambiguity this thread nearly lost a round to.
 */
export const billboardProbe = { enabled: true };

interface Row {
  key: string;
  path: string;
  bone: number;
  parentID: number;
  flags: number;
  type: number;
  hasSkin: boolean;
  /**
   * WHAT `applyBillboards`' SWITCH ACTUALLY READS, as a `typeof` string plus its value.
   *
   * The dispatcher is `switch (bone.userData.billboardType) { case 0: ... case 3: ... default: break }`
   * (`m2/index.ts:1011-1026`). `bind-pose.ts:72` fills it from `boneDef.billboardType`, and in
   * `wow-data-parser/m2/index.js` that member is declared as a FUNCTION. If restructure does not
   * evaluate it as a computed property, the value here is a function, every `case` misses, `default`
   * breaks, and **not one billboard is ever written anywhere in the game** -- while every field the
   * five earlier refutations checked still inspects as correct. `dispatchType` "number" clears that;
   * "function" is the defect.
   *
   * `billboardsLen` rides along because the same question decides it: `billboarded()` in that parser
   * tests `this.billboardType !== null`, which a function always satisfies, so an unevaluated getter
   * would also put EVERY bone in the billboards list. 2 of 8 for this model is right; 8 of 8 is the
   * same bug seen from the other side.
   *
   * **ALREADY REFUTED STATICALLY -- these two fields are a live CONFIRMATION, not the hypothesis.**
   * Decoded through `M2Parser`, `DemonArmor_Impact_Head` reports `billboardType` = **3** (number) on
   * bone 0 and **0** on bone 2, `billboarded` a real boolean, and exactly **2 of 8** bones
   * billboarded (`__bench__/effect-emitter-probe.test.ts`). So restructure does evaluate the
   * computed members, the switch matches `case 3` and `case 0`, and both are implemented. They are
   * still reported because the parsed value and the value on `userData` at frame N are two different
   * objects, and this thread has now been wrong six times about things that inspect correctly.
   */
  dispatchType: string;
  dispatchValue: string;
  billboardsLen: number;
  frames: number;
  writerRotDeg: number;
  writerRotMaxChangeDeg: number;
  paletteRotDegModelSpace: number;
  paletteRotMaxChangeDeg: number;
  seededWriter: boolean;
  seededPalette: boolean;
  prevWriter: THREE.Quaternion;
  prevPalette: THREE.Quaternion;
}

const rows = new Map<string, Row>();

const IDENTITY = new THREE.Quaternion();
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchModelSpace = new THREE.Matrix4();
const prevCameraQuat = new THREE.Quaternion();

let cameraSeeded = false;
let cameraFrame = -1;
let cameraRotMaxChangeDeg = 0;
let cameraRotTotalDeg = 0;

/** Signed angle between two unit quaternions, in degrees. */
const angleBetween = (a: THREE.Quaternion, b: THREE.Quaternion): number => {
  const dot = Math.min(1, Math.abs(a.dot(b)));
  return (2 * Math.acos(dot) * 180) / Math.PI;
};

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The billboard TYPE the parser derives, re-derived here so the row is self-describing. */
const typeOf = (flags: number): number => {
  if (flags & 0x08) return 0;
  if (flags & 0x10) return 1;
  if (flags & 0x20) return 2;
  if (flags & 0x40) return 3;
  return -1;
};


/**
 * Advance the CAMERA's own rotation window. Once per frame, before any instance is sampled --
 * `frameIndex` is what makes it once rather than once per live kit.
 *
 * WITHOUT THIS THE TEST CANNOT BE READ. A zero writer delta means "the writer is broken" only if the
 * camera actually moved; with a still camera zero is correct and expected, which is exactly what made
 * the owner's first read useless. The first sample only SEEDS the reference and contributes no delta,
 * or frame one would report the camera's whole orientation as a change.
 */
export function sampleCamera(camera: THREE.Camera | undefined, frameIndex: number): void {
  if (!billboardProbe.enabled || camera === undefined || frameIndex === cameraFrame) {
    return;
  }
  cameraFrame = frameIndex;
  if (!cameraSeeded) {
    prevCameraQuat.copy(camera.quaternion);
    cameraSeeded = true;
    return;
  }
  const delta = angleBetween(camera.quaternion, prevCameraQuat);
  prevCameraQuat.copy(camera.quaternion);
  cameraRotTotalDeg += delta;
  if (delta > cameraRotMaxChangeDeg) {
    cameraRotMaxChangeDeg = delta;
  }
}

/** Zero every accumulator, so a fresh attempt is not read against an old session's maxima. */
export function resetBillboardProbe(): void {
  rows.clear();
  cameraSeeded = false;
  cameraRotMaxChangeDeg = 0;
  cameraRotTotalDeg = 0;
}

/**
 * Sample one instance's billboarded bones. Call TWICE per frame: once right after
 * `applyBillboards` with `stage` "writer", and once after `updateMatrixWorld(true)` with "palette".
 *
 * Split into two calls rather than one because the whole point is that the two values are read at
 * two different moments in the frame. Reading them together would sample the palette AFTER the walk
 * either way and could not tell a stale palette from a fresh one.
 */
export function sampleBillboards(model: unknown, stage: 'writer' | 'palette'): void {
  if (!billboardProbe.enabled) {
    return;
  }
  const host = model as {
    path?: string;
    matrixWorld?: THREE.Matrix4;
    bones?: THREE.Object3D[];
    billboards?: Array<THREE.Object3D & { skin?: unknown }>;
    data?: { bones?: Array<{ flags?: number; parentID?: number }> };
  };
  const bones = host.billboards;
  if (!bones || bones.length === 0) {
    return;
  }
  const path = String(host.path ?? '?');

  for (let i = 0; i < bones.length; i += 1) {
    const bone = bones[i];
    // BY IDENTITY, not by position in `billboards`. Nothing stores a bone index on the bone
    // (`bind-pose.ts:69-75` sets `userData.billboarded` and `billboardType` and no index), and
    // `billboards` is a FILTERED list -- for `DemonArmor_Impact_Head` it holds bones 0 and 2, so
    // using the loop counter would read bone 1's flags into the second row and libel a bone that is
    // not billboarded at all. `-1` when unresolvable, which the row shows rather than hides.
    const index = (host.bones ?? []).indexOf(bone);
    // KEYED BY MODEL PATH, never by guid: the maxima must outlive the instance and accumulate
    // across casts, which is what makes the sequence "turn, cast, keep turning, read" work.
    const rowKey = path + ':' + String(index);
    let row = rows.get(rowKey);
    if (row === undefined) {
      const def = index >= 0 ? host.data?.bones?.[index] : undefined;
      const flags = Number(def?.flags ?? 0);
      row = {
        key: rowKey,
        path,
        bone: index,
        parentID: Number(def?.parentID ?? -99),
        flags,
        type: typeOf(flags),
        hasSkin: Boolean(bone.skin),
        dispatchType: 'unsampled',
        dispatchValue: 'unsampled',
        billboardsLen: bones.length,
        frames: 0,
        writerRotDeg: 0,
        writerRotMaxChangeDeg: 0,
        paletteRotDegModelSpace: 0,
        paletteRotMaxChangeDeg: 0,
        seededWriter: false,
        seededPalette: false,
        prevWriter: new THREE.Quaternion(),
        prevPalette: new THREE.Quaternion(),
      };
      rows.set(rowKey, row);
    }

    if (stage === 'writer') {
      // The bone's OWN quaternion, straight after `applyBillboards` wrote its Euler. three links
      // `rotation` to `quaternion` through an onChange callback, so this is the writer's output.
      row.writerRotDeg = round(angleBetween(bone.quaternion, IDENTITY));
      if (row.seededWriter) {
        const delta = angleBetween(bone.quaternion, row.prevWriter);
        if (delta > row.writerRotMaxChangeDeg) {
          row.writerRotMaxChangeDeg = round(delta);
        }
      }
      row.prevWriter.copy(bone.quaternion);
      row.seededWriter = true;
      // `hasSkin` is re-read every frame, not just on creation: `applyBatches` publishes it later
      // than the first tick, and a row that cached `false` at spawn would libel the writer for ever.
      row.hasSkin = Boolean(bone.skin);
      const raw = (bone.userData as { billboardType?: unknown } | undefined)?.billboardType;
      row.dispatchType = typeof raw;
      row.dispatchValue = typeof raw === 'function' ? 'FUNCTION (never matches a case)' : String(raw);
      row.billboardsLen = bones.length;
      row.frames += 1;
      continue;
    }

    // What SKINNING reads. `Skeleton#update` builds every palette entry from `bone.matrixWorld`, so
    // this is the value that reaches the vertex shader -- decomposed rather than dumped, because
    // sixteen floats per bone per frame is not something anyone reads at a console.
    // MODEL SPACE, not world -- v1 decomposed `bone.matrixWorld` and reported 125.742 deg against
    // the writer's 45.265. That difference was neither a defect nor a surprise: `matrixWorld`
    // composes the ENTIRE chain to the world, including the host character's facing, so it is a
    // world total while the writer's is a local rotation. Two different quantities under names that
    // did not say so -- the exact ambiguity this module's v1 doc warned about, committed inside the
    // warning. It also made the test non-specific: turning the CHARACTER moved it with the billboard
    // entirely dead.
    //
    // What the vertex receives is `P_i`, the bone's MODEL-space posed matrix
    // (`anim/skinning-scope.ts`: `Skeleton#update` writes `boneMatrix_i = W . P_i . B_i^-1` and
    // three's `AttachedBindMode` divides `W` back out), so the host's facing cancels here and only
    // the billboard can move this number.
    if (host.matrixWorld === undefined) {
      continue;
    }
    scratchModelSpace.copy(host.matrixWorld).invert().multiply(bone.matrixWorld);
    scratchModelSpace.decompose(scratchPos, scratchQuat, scratchScale);
    row.paletteRotDegModelSpace = round(angleBetween(scratchQuat, IDENTITY));
    if (row.seededPalette) {
      const delta = angleBetween(scratchQuat, row.prevPalette);
      if (delta > row.paletteRotMaxChangeDeg) {
        row.paletteRotMaxChangeDeg = round(delta);
      }
    }
    row.prevPalette.copy(scratchQuat);
    row.seededPalette = true;
  }
}

export function billboardRows(): Record<string, unknown> {
  return {
    cameraRotMaxChangeDeg: round(cameraRotMaxChangeDeg),
    cameraRotTotalDeg: round(cameraRotTotalDeg),
    verdict: cameraRotMaxChangeDeg < 0.5
      ? 'NULL TEST -- the camera barely moved; every row below proves nothing'
      : 'camera moved; compare writerRotMaxChangeDeg against paletteRotMaxChangeDeg per row',
    rows: Array.from(rows.values()).map((row) => ({
      frames: row.frames,
      path: row.path,
      bone: row.bone,
      parentID: row.parentID,
      flags: '0x' + row.flags.toString(16),
      type: row.type,
      hasSkin: row.hasSkin,
      dispatchType: row.dispatchType,
      dispatchValue: row.dispatchValue,
      billboardsLen: row.billboardsLen,
      writerRotDeg: row.writerRotDeg,
      writerRotMaxChangeDeg: row.writerRotMaxChangeDeg,
      paletteRotDegModelSpace: row.paletteRotDegModelSpace,
      paletteRotMaxChangeDeg: row.paletteRotMaxChangeDeg,
    })),
  };
}
