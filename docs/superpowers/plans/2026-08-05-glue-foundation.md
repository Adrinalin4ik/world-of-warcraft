# Glue Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the in-canvas widget layer and the 3D glue scene the four pre-world screens stand on, plus a networking-free debug route into the world.

**Architecture:** A new `client/src/game/ui/` subsystem. All geometry and interaction logic is pure TypeScript with no three.js import (`layout.ts`, `hit.ts`, `strings.ts`, `scene/tokens.ts`, `scene/scene-rig.ts`) so it is testable in jsdom; only `renderer.ts`, `material.ts`, `text.ts`, `art.ts` and `scene/glue-scene.ts` touch three.js. Screens are plain modules driven by a `ClientState` machine, hosted by one React route that owns a full-window canvas. The 3D half loads `Interface\Glues\Models\UI_<token>\UI_<token>.m2` through the existing `M2Blueprint`, frames it with the model's authored camera 0, and pushes fog/lights onto uniforms the M2 material already has.

**Tech Stack:** TypeScript, three.js 0.185, restructure (binary parsing), React 19 (host only), jest + jsdom.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-glue-foundation-design.md`. Read it before Task 1.
- Client build is **3.3.5a (12340)**. Assets come from the host in [`game/net/loader.js`](../../../client/src/game/net/loader.js); paths are MPQ-style with backslashes and are normalized by the loader.
- **`samples/benilla` is 1.12.1.** Where its behaviour and our `interface/gluexml/*.lua` disagree, **our client data wins** — the two known divergences are in the spec §5.1.
- Scale law: `scale = min(viewportHeight / 768, 2.2)`. Upper clamp only — **never add a lower clamp.**
- **No hardcoded UI text and no hardcoded art paths in screen code.** Text comes from `GlueStrings`, art from a `GlueArt` table.
- M2 records here are the **WotLK (version 264)** shapes: an `M2Track` header is 20 bytes (no `ranges` array). Vanilla record strides quoted in benilla (`0x7c` camera, `0xd4` light, `48` attachment) are 1.12 numbers and do **not** apply; using the repo's `AnimationBlock` produces the right strides automatically.
- Run one test file with: `cd client && npm test -- --watchAll=false --testPathPattern=<pattern>`
- Existing infrastructure to reuse, never reimplement: `M2Blueprint.load`, `TextureLoader.load`, `applyPerObjectLighting`, `propProbeCoeffs`, `packFogParams`, `worldClock`.
- Commit after every task.

---

### Task 1: M2 parser — cameras

The glue scene is framed by the model's authored camera 0, and `cameras` is currently declared `new Nofs()` — a typeless `Nofs` reads the count, discards the offset and returns no payload.

**Files:**
- Modify: `client/src/wow-data-parser/m2/index.js:156-157` (the `cameras` / `cameraLookups` lines)
- Test: `client/src/wow-data-parser/m2/__tests__/camera.test.js`

**Interfaces:**
- Consumes: `AnimationBlock` from `./animation-block`, `float32array3` from `../types`.
- Produces: named export `Camera` from `wow-data-parser/m2/index.js`; parsed models gain `data.cameras: Array<{type, fov, farClip, nearClip, positions, positionBase, targetPositions, targetBase, roll}>` and `data.cameraLookups: number[]`. Track values are spline keys: `positions.tracks[0].values[0] = {value: [x,y,z], inTan, outTan}`.

- [ ] **Step 1: Write the failing test**

```js
/** @jest-environment node */
import { DecodeStream } from 'restructure';

import { Camera } from '../index';

/**
 * One camera record laid out as a 3.3.5 (version 264) M2 stores it, decoded from byte 0.
 *
 * Record: type i32, fov f32, farClip f32, nearClip f32, position track (20 B), positionBase C3,
 * target track (20 B), targetBase C3, roll track (20 B) -> stride 0x64. The vanilla stride is 0x7c
 * because 1.12 tracks carry an extra `ranges` array; that is exactly what this test pins down.
 *
 * Camera track values are M2SplineKey triples (value, inTan, outTan), NOT bare vectors -- 36 bytes
 * per key for a C3. Reading them as bare vec3 would misalign every key after the first.
 */
function buildCamera() {
  const buffer = Buffer.alloc(0xa0);

  buffer.writeInt32LE(0, 0x00);        // type
  buffer.writeFloatLE(0.8, 0x04);      // fov (radians, DIAGONAL -- see scene-rig/glue-scene)
  buffer.writeFloatLE(500, 0x08);      // farClip
  buffer.writeFloatLE(0.5, 0x0c);      // nearClip

  buffer.writeUInt16LE(0, 0x10);       // positions: interpolationType
  buffer.writeInt16LE(-1, 0x12);       // positions: globalSequenceID
  buffer.writeUInt32LE(1, 0x14);       // 1 timestamp track
  buffer.writeUInt32LE(0x64, 0x18);    // ...at 0x64
  buffer.writeUInt32LE(1, 0x1c);       // 1 value track
  buffer.writeUInt32LE(0x70, 0x20);    // ...at 0x70

  buffer.writeFloatLE(1, 0x24);        // positionBase
  buffer.writeFloatLE(2, 0x28);
  buffer.writeFloatLE(3, 0x2c);

  // target track (0x30) and roll track (0x50) left as zero counts -- unkeyed, which is the common
  // authored case for a glue scene camera.

  buffer.writeFloatLE(4, 0x44);        // targetBase
  buffer.writeFloatLE(5, 0x48);
  buffer.writeFloatLE(6, 0x4c);

  buffer.writeUInt32LE(1, 0x64);       // timestamp track 0: 1 key
  buffer.writeUInt32LE(0x6c, 0x68);    // ...at 0x6c
  buffer.writeUInt32LE(0, 0x6c);       // t = 0

  buffer.writeUInt32LE(1, 0x70);       // value track 0: 1 key
  buffer.writeUInt32LE(0x78, 0x74);    // ...at 0x78
  buffer.writeFloatLE(0.5, 0x78);      // spline key: value.x
  buffer.writeFloatLE(0, 0x7c);        // value.y
  buffer.writeFloatLE(0, 0x80);        // value.z
  // inTan (0x84) and outTan (0x90) stay zero

  return buffer;
}

describe('M2 Camera', () => {
  it('decodes the authored framing fields', () => {
    const camera = Camera.decode(new DecodeStream(buildCamera()));

    expect(camera.fov).toBeCloseTo(0.8);
    expect(camera.farClip).toBeCloseTo(500);
    expect(camera.nearClip).toBeCloseTo(0.5);
    expect(Array.from(camera.positionBase)).toEqual([1, 2, 3]);
    expect(Array.from(camera.targetBase)).toEqual([4, 5, 6]);
  });

  it('decodes position keys as spline-key triples', () => {
    const camera = Camera.decode(new DecodeStream(buildCamera()));
    const key = camera.positions.tracks[0].values[0];

    expect(Array.from(key.value)).toEqual([0.5, 0, 0]);
    expect(Array.from(key.inTan)).toEqual([0, 0, 0]);
  });

  it('consumes exactly the 3.3.5 record stride', () => {
    const stream = new DecodeStream(buildCamera());
    Camera.decode(stream);

    // 0x64, not vanilla's 0x7c. A wrong stride shifts every camera after the first.
    expect(stream.pos).toBe(0x64);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=camera`
Expected: FAIL — `Camera` is not exported from `../index`.

- [ ] **Step 3: Write the implementation**

In `client/src/wow-data-parser/m2/index.js`, add the spline-key types and the camera struct above the default export (after the `UVAnimation` struct):

```js
/**
 * An `M2SplineKey<T>` -- value plus its two tangents. Camera position/target/roll tracks store
 * these ALWAYS, regardless of the block's interpolation type, so a key is 3x the value size.
 */
const SplineKeyVec3 = new r.Struct({
  value: float32array3,
  inTan: float32array3,
  outTan: float32array3
});

const SplineKeyFloat = new r.Struct({
  value: r.floatle,
  inTan: r.floatle,
  outTan: r.floatle
});

/**
 * One authored camera. `SetCamera(index)` in GlueXML indexes this array DIRECTLY -- the glue scene
 * models carry a single camera whose `cameraLookups` slot holds the 0xffff none sentinel, so the
 * portrait-style lookup path finds nothing there (benilla `models/records.rs#parse_m2_camera`).
 *
 * `fov` is the client's DIAGONAL opening angle, not a vertical FOV. The conversion for our aspect
 * lives in `game/ui/scene/scene-rig.ts#verticalFov`.
 */
export const Camera = new r.Struct({
  type: r.int32le,
  fov: r.floatle,
  farClip: r.floatle,
  nearClip: r.floatle,
  positions: new AnimationBlock(SplineKeyVec3),
  positionBase: float32array3,
  targetPositions: new AnimationBlock(SplineKeyVec3),
  targetBase: float32array3,
  roll: new AnimationBlock(SplineKeyFloat)
});
```

Then replace the two header lines:

```js
  cameras: new Nofs(Camera),
  cameraLookups: new Nofs(r.int16le),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=camera`
Expected: PASS (3 tests)

- [ ] **Step 5: Verify nothing else regressed**

Run: `cd client && npm test -- --watchAll=false --testPathPattern="wow-data-parser"`
Expected: PASS — the parser's existing suites are unaffected.

- [ ] **Step 6: Commit**

```bash
git add client/src/wow-data-parser/m2/index.js client/src/wow-data-parser/m2/__tests__/camera.test.js
git commit -m "feat(m2): parse authored cameras"
```

---

### Task 2: M2 parser — lights and attachments

The scene's point lights and the character's stage spot. Both chunks are skipped today for the same reason as cameras.

**Files:**
- Modify: `client/src/wow-data-parser/m2/index.js:152-155` (`attachments`, `attachmentLookups`, `lights`)
- Test: `client/src/wow-data-parser/m2/__tests__/light-attachment.test.js`

**Interfaces:**
- Produces: named exports `Light`, `Attachment`. Models gain `data.lights: Array<{type, bone, position, ambientColor, ambientIntensity, diffuseColor, diffuseIntensity, attenuationStart, attenuationEnd, visibility}>`, `data.attachments: Array<{id, bone, position, animateAttached}>`, `data.attachmentLookups: number[]`. Colour/intensity/visibility fields are `AnimationBlock`s — read representative values with `block.firstKeyframe`.

- [ ] **Step 1: Write the failing test**

```js
/** @jest-environment node */
import { DecodeStream } from 'restructure';

import { Attachment, Light } from '../index';

/**
 * A 3.3.5 light record: type u16, bone i16, position C3, then SEVEN 20-byte tracks -- ambient
 * colour/intensity, diffuse colour/intensity, attenuation start/end, visibility. Stride 0x9c.
 * (Vanilla's is 0xd4 because its tracks are 0x1c.)
 */
function buildLight() {
  const buffer = Buffer.alloc(0x100);

  buffer.writeUInt16LE(1, 0x00);   // type: 1 = point (the hot-spot caster)
  buffer.writeInt16LE(-1, 0x02);   // bone: -1 = model origin
  buffer.writeFloatLE(7, 0x04);    // position
  buffer.writeFloatLE(8, 0x08);
  buffer.writeFloatLE(9, 0x0c);

  // diffuse colour track lives at 0x10 + 2 * 20 = 0x38. One key, one vec3.
  buffer.writeUInt16LE(0, 0x38);
  buffer.writeInt16LE(-1, 0x3a);
  buffer.writeUInt32LE(1, 0x3c);      // 1 timestamp track
  buffer.writeUInt32LE(0xa0, 0x40);
  buffer.writeUInt32LE(1, 0x44);      // 1 value track
  buffer.writeUInt32LE(0xb0, 0x48);

  buffer.writeUInt32LE(1, 0xa0);      // timestamps: 1 key
  buffer.writeUInt32LE(0xa8, 0xa4);
  buffer.writeUInt32LE(0, 0xa8);

  buffer.writeUInt32LE(1, 0xb0);      // values: 1 key
  buffer.writeUInt32LE(0xb8, 0xb4);
  buffer.writeFloatLE(1.0, 0xb8);     // warm orange
  buffer.writeFloatLE(0.6, 0xbc);
  buffer.writeFloatLE(0.2, 0xc0);

  return buffer;
}

/** A 3.3.5 attachment: id u32, bone u16, unknown u16, position C3, one 20-byte track. Stride 40. */
function buildAttachment() {
  const buffer = Buffer.alloc(0x40);

  buffer.writeUInt32LE(0, 0x00);   // id 0 -- the glue stage spot
  buffer.writeUInt16LE(3, 0x04);   // bone
  buffer.writeUInt16LE(0, 0x06);
  buffer.writeFloatLE(-1.5, 0x08); // position
  buffer.writeFloatLE(0.25, 0x0c);
  buffer.writeFloatLE(2, 0x10);

  return buffer;
}

describe('M2 Light', () => {
  it('decodes type, bone and position', () => {
    const light = Light.decode(new DecodeStream(buildLight()));

    expect(light.type).toBe(1);
    expect(light.bone).toBe(-1);
    expect(Array.from(light.position)).toEqual([7, 8, 9]);
  });

  it('decodes the diffuse colour track', () => {
    const light = Light.decode(new DecodeStream(buildLight()));
    const key = light.diffuseColor.firstKeyframe;

    expect(Array.from(key.value)).toEqual([1, 0.6000000238418579, 0.20000000298023224]);
  });

  it('consumes exactly the 3.3.5 record stride', () => {
    const stream = new DecodeStream(buildLight());
    Light.decode(stream);

    expect(stream.pos).toBe(0x9c);
  });
});

describe('M2 Attachment', () => {
  it('decodes id, bone and model-space position', () => {
    const attachment = Attachment.decode(new DecodeStream(buildAttachment()));

    expect(attachment.id).toBe(0);
    expect(attachment.bone).toBe(3);
    expect(Array.from(attachment.position)).toEqual([-1.5, 0.25, 2]);
  });

  it('consumes exactly the 3.3.5 record stride', () => {
    const stream = new DecodeStream(buildAttachment());
    Attachment.decode(stream);

    expect(stream.pos).toBe(40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=light-attachment`
Expected: FAIL — `Light` / `Attachment` are not exported.

- [ ] **Step 3: Write the implementation**

Add above the default export in `client/src/wow-data-parser/m2/index.js`:

```js
/**
 * An authored M2 light. `type` 0 is directional, 1 is an omnidirectional point light with the
 * engine's FIXED falloff `1 / (0.7d + 0.03d^2)` -- the authored attenuation range is a cull hint,
 * not the curve (benilla `models/records.rs`, byte-verified).
 *
 * For 3.3.5 glue scenes only the POINT lights matter: `glueparent.lua:50` states the directional
 * rig moved into the Lua `RaceLights` table for this build ("the models no longer contain
 * directional lights"), and `:361` confirms the engine "pulls the default point lights from the
 * models".
 */
export const Light = new r.Struct({
  type: r.uint16le,
  bone: r.int16le,
  position: float32array3,
  ambientColor: new AnimationBlock(float32array3),
  ambientIntensity: new AnimationBlock(r.floatle),
  diffuseColor: new AnimationBlock(float32array3),
  diffuseIntensity: new AnimationBlock(r.floatle),
  attenuationStart: new AnimationBlock(r.floatle),
  attenuationEnd: new AnimationBlock(r.floatle),
  visibility: new AnimationBlock(r.uint8)
});

/**
 * An attachment point. Records are addressed by ARRAY INDEX here; `attachmentLookups` maps an
 * attachment ID to that index. The glue screens' character stands on attachment **id 0** -- the
 * stage spot, on camera 0's axis in every UI_* scene (benilla byte-verified id 0, not 1).
 */
export const Attachment = new r.Struct({
  id: r.uint32le,
  bone: r.uint16le,
  unknown: r.uint16le,
  position: float32array3,
  animateAttached: new AnimationBlock(r.uint8)
});
```

Then replace the three header lines:

```js
  attachments: new Nofs(Attachment),
  attachmentLookups: new Nofs(r.int16le),
  events: new Nofs(),
  lights: new Nofs(Light),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=light-attachment`
Expected: PASS (5 tests)

- [ ] **Step 5: Verify the whole parser and the M2 pipeline still pass**

Run: `cd client && npm test -- --watchAll=false --testPathPattern="wow-data-parser|pipeline/m2"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/wow-data-parser/m2/index.js client/src/wow-data-parser/m2/__tests__/light-attachment.test.js
git commit -m "feat(m2): parse lights and attachments"
```

---

### Task 3: Layout — units, the scale law, anchor resolution

**Files:**
- Create: `client/src/game/ui/layout.ts`
- Test: `client/src/game/ui/__tests__/layout.test.ts`

**Interfaces:**
- Produces: `AUTHORED_HEIGHT`, `MAX_SCALE`, `screenScale(viewportHeight)`, `viewportUnits(viewport)`, types `AnchorPoint`, `Anchor`, `Rect`, `LayoutNode`, `Viewport`, and `resolveAnchors(nodes, viewport): Map<string, Rect>`. Every later task uses `Rect` (`{left, top, width, height}`, logical units, y measured DOWN from the top of the window) and `Anchor`.

- [ ] **Step 1: Write the failing test**

```ts
import {
  AUTHORED_HEIGHT,
  MAX_SCALE,
  resolveAnchors,
  screenScale,
  viewportUnits,
} from '../layout';

describe('screenScale', () => {
  it('is 1 at the authored height', () => {
    expect(screenScale(AUTHORED_HEIGHT)).toBe(1);
  });

  it('scales DOWN below the authored height -- there is no lower clamp', () => {
    // A floor of 1.0 would draw the 768-tall layout into a 677-tall window and drop the bottom-most
    // controls off the screen silently (benilla reproduced exactly this at WOW_WIN=1276x677).
    expect(screenScale(677)).toBeCloseTo(677 / 768);
    expect(screenScale(677)).toBeLessThan(1);
  });

  it('clamps above MAX_SCALE', () => {
    expect(screenScale(2160)).toBe(MAX_SCALE);
  });
});

describe('viewportUnits', () => {
  it('reports the window in logical units', () => {
    const units = viewportUnits({ width: 1920, height: 1080 });

    expect(units.scale).toBeCloseTo(1080 / 768);
    expect(units.height).toBeCloseTo(768);
    // Wider than the authored 4:3 -- a widescreen window reveals more width, it does not letterbox.
    expect(units.width).toBeCloseTo(1920 / (1080 / 768));
  });
});

describe('resolveAnchors', () => {
  const viewport = { width: 1024, height: 768 };

  it('centres a node on CENTER with no offset', () => {
    const rects = resolveAnchors(
      [{ id: 'panel', width: 200, height: 100, anchors: [{ point: 'CENTER', x: 0, y: 0 }] }],
      viewport,
    );

    expect(rects.get('panel')).toEqual({ left: 412, top: 334, width: 200, height: 100 });
  });

  it('offsets from TOPLEFT with +y meaning UP, as FrameXML does', () => {
    const rects = resolveAnchors(
      [{ id: 'logo', width: 100, height: 50, anchors: [{ point: 'TOPLEFT', x: 20, y: -30 }] }],
      viewport,
    );

    expect(rects.get('logo')).toEqual({ left: 20, top: 30, width: 100, height: 50 });
  });

  it('anchors BOTTOMRIGHT against the window corner', () => {
    const rects = resolveAnchors(
      [{ id: 'quit', width: 120, height: 40, anchors: [{ point: 'BOTTOMRIGHT', x: -10, y: 10 }] }],
      viewport,
    );

    expect(rects.get('quit')).toEqual({ left: 894, top: 718, width: 120, height: 40 });
  });

  it('sizes a node from two opposing anchors -- this is what setAllPoints needs', () => {
    const rects = resolveAnchors(
      [
        {
          id: 'backdrop',
          width: 0,
          height: 0,
          anchors: [
            { point: 'TOPLEFT', x: 0, y: 0 },
            { point: 'BOTTOMRIGHT', x: 0, y: 0 },
          ],
        },
      ],
      viewport,
    );

    expect(rects.get('backdrop')).toEqual({ left: 0, top: 0, width: 1024, height: 768 });
  });

  it('anchors relative to another node', () => {
    const rects = resolveAnchors(
      [
        { id: 'box', width: 200, height: 32, anchors: [{ point: 'TOPLEFT', x: 100, y: -100 }] },
        {
          id: 'label',
          width: 60,
          height: 12,
          anchors: [{ point: 'BOTTOMLEFT', relativeTo: 'box', relativePoint: 'TOPLEFT', x: 0, y: 4 }],
        },
      ],
      viewport,
    );

    // The label sits 4 units above the box's top edge, left edges flush.
    expect(rects.get('label')).toEqual({ left: 100, top: 84, width: 60, height: 12 });
  });

  it('resolves in dependency order regardless of input order', () => {
    const rects = resolveAnchors(
      [
        {
          id: 'child',
          width: 10,
          height: 10,
          anchors: [{ point: 'TOPLEFT', relativeTo: 'parent', relativePoint: 'TOPLEFT', x: 5, y: 0 }],
        },
        { id: 'parent', width: 100, height: 100, anchors: [{ point: 'TOPLEFT', x: 50, y: 0 }] },
      ],
      viewport,
    );

    expect(rects.get('child')!.left).toBe(55);
  });

  it('throws on an anchor cycle instead of looping', () => {
    expect(() =>
      resolveAnchors(
        [
          { id: 'a', width: 1, height: 1, anchors: [{ point: 'TOPLEFT', relativeTo: 'b', x: 0, y: 0 }] },
          { id: 'b', width: 1, height: 1, anchors: [{ point: 'TOPLEFT', relativeTo: 'a', x: 0, y: 0 }] },
        ],
        viewport,
      ),
    ).toThrow(/cycle/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=ui/__tests__/layout`
Expected: FAIL — cannot resolve `../layout`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Glue layout: authored units, the virtual-screen scale law, and FrameXML anchor resolution.
 *
 * Deliberately free of three.js. Everything here is arithmetic over plain objects so it can be
 * tested in jsdom -- the renderer is the only file that turns these rects into meshes.
 *
 * Coordinates: logical units matching the authored GlueXML values, with `top` measured DOWNWARD
 * from the top of the window (screen convention). Anchor OFFSETS keep FrameXML's convention
 * instead: `+y` is UP. The two meet in `pointOf`/`placeFromAnchor` below and nowhere else.
 */

/** The height the reference authors every glue screen against. */
export const AUTHORED_HEIGHT = 768;

/**
 * The upper clamp on the virtual-screen scale: the shipped size on a tall display. There is
 * deliberately NO lower clamp -- see `screenScale`.
 */
export const MAX_SCALE = 2.2;

export type AnchorPoint =
  | 'TOPLEFT' | 'TOP' | 'TOPRIGHT'
  | 'LEFT' | 'CENTER' | 'RIGHT'
  | 'BOTTOMLEFT' | 'BOTTOM' | 'BOTTOMRIGHT';

export interface Anchor {
  /** The point ON THIS NODE being placed. */
  point: AnchorPoint;
  /** Id of the node to anchor against; the window when absent. */
  relativeTo?: string;
  /** The point on the relative node; mirrors `point` when absent. */
  relativePoint?: AnchorPoint;
  /** Offset in logical units. `+x` right, `+y` UP (FrameXML). */
  x: number;
  y: number;
}

/** Logical units, `top` measured downward from the window's top edge. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LayoutNode {
  id: string;
  /** Ignored on an axis constrained by two opposing anchors. */
  width: number;
  height: number;
  anchors: Anchor[];
}

/** The window in device pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * The virtual-screen scale: authored units to device pixels.
 *
 * The reference lays each glue screen out on a 768-unit-tall virtual screen and scales it by the
 * window height. The upper clamp is the shipped size on a tall screen. **Adding a lower clamp is a
 * bug**: it draws the full-height layout into a shorter window, and the overflow silently falls off
 * the bottom -- always the bottom-most controls (benilla lost the last customization row and the
 * RANDOMIZE button this way at 1276x677).
 */
export function screenScale(viewportHeight: number): number {
  return Math.min(viewportHeight / AUTHORED_HEIGHT, MAX_SCALE);
}

/**
 * The window expressed in logical units. Height is ~768 (exactly 768 below the clamp); width grows
 * with the window's aspect, so a widescreen window shows MORE WIDTH rather than letterboxing.
 */
export function viewportUnits(viewport: Viewport): { width: number; height: number; scale: number } {
  const scale = screenScale(viewport.height);
  return { width: viewport.width / scale, height: viewport.height / scale, scale };
}

const HORIZONTAL: Record<AnchorPoint, number> = {
  TOPLEFT: 0, LEFT: 0, BOTTOMLEFT: 0,
  TOP: 0.5, CENTER: 0.5, BOTTOM: 0.5,
  TOPRIGHT: 1, RIGHT: 1, BOTTOMRIGHT: 1,
};

const VERTICAL: Record<AnchorPoint, number> = {
  TOPLEFT: 0, TOP: 0, TOPRIGHT: 0,
  LEFT: 0.5, CENTER: 0.5, RIGHT: 0.5,
  BOTTOMLEFT: 1, BOTTOM: 1, BOTTOMRIGHT: 1,
};

/** The absolute position of one point on a rect. */
function pointOf(rect: Rect, point: AnchorPoint): { x: number; y: number } {
  return {
    x: rect.left + rect.width * HORIZONTAL[point],
    y: rect.top + rect.height * VERTICAL[point],
  };
}

function resolveOne(node: LayoutNode, resolved: Map<string, Rect>, screen: Rect): Rect {
  // Edge constraints gathered from the anchors. An axis with two of them SIZES the node.
  let left: number | null = null;
  let right: number | null = null;
  let top: number | null = null;
  let bottom: number | null = null;

  for (const anchor of node.anchors) {
    const relative = anchor.relativeTo ? resolved.get(anchor.relativeTo) : screen;
    if (!relative) {
      throw new Error(`anchor of "${node.id}" references unresolved node "${anchor.relativeTo}"`);
    }

    const target = pointOf(relative, anchor.relativePoint ?? anchor.point);
    // FrameXML's `+y` is up; our `top` grows downward, hence the subtraction.
    const x = target.x + anchor.x;
    const y = target.y - anchor.y;

    const h = HORIZONTAL[anchor.point];
    if (h === 0) {
      left = x;
    } else if (h === 1) {
      right = x;
    } else {
      left = x - node.width / 2;
    }

    const v = VERTICAL[anchor.point];
    if (v === 0) {
      top = y;
    } else if (v === 1) {
      bottom = y;
    } else {
      top = y - node.height / 2;
    }
  }

  const width = left !== null && right !== null ? right - left : node.width;
  const height = top !== null && bottom !== null ? bottom - top : node.height;

  return {
    left: left !== null ? left : right !== null ? right - width : 0,
    top: top !== null ? top : bottom !== null ? bottom - height : 0,
    width,
    height,
  };
}

/**
 * Resolve every node's rect. Nodes may anchor to each other in any input order; a cycle throws
 * rather than spinning.
 */
export function resolveAnchors(nodes: LayoutNode[], viewport: Viewport): Map<string, Rect> {
  const units = viewportUnits(viewport);
  const screen: Rect = { left: 0, top: 0, width: units.width, height: units.height };

  const resolved = new Map<string, Rect>();
  let pending = nodes.slice();

  while (pending.length > 0) {
    const ready = pending.filter((node) =>
      node.anchors.every((anchor) => !anchor.relativeTo || resolved.has(anchor.relativeTo)),
    );

    if (ready.length === 0) {
      throw new Error(
        `anchor cycle among: ${pending.map((node) => node.id).join(', ')}`,
      );
    }

    for (const node of ready) {
      resolved.set(node.id, resolveOne(node, resolved, screen));
    }

    pending = pending.filter((node) => !resolved.has(node.id));
  }

  return resolved;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=ui/__tests__/layout`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/ui/layout.ts client/src/game/ui/__tests__/layout.test.ts
git commit -m "feat(ui): add the glue layout law and anchor resolution"
```

---

### Task 4: The widget tree

**Files:**
- Create: `client/src/game/ui/widget.ts`

**Interfaces:**
- Consumes: `Anchor`, `LayoutNode`, `Rect`, `Viewport`, `resolveAnchors` from `./layout`.
- Produces: `Layer`, `LAYER_ORDER`, `Blend`, `TexCoords`, `WidgetKind`, `class Widget`, `class WidgetRoot`, `interface DrawItem { widget: Widget; rect: Rect; alpha: number }`, `WidgetRoot#drawList(viewport): DrawItem[]`. Art is referenced by **sprite key** (a string resolved later by `GlueArt`), never by texture — that is what keeps this file three.js-free.

- [ ] **Step 1: Write the implementation**

```ts
/**
 * The retained glue widget tree.
 *
 * Screens build widgets on mount and MUTATE them; nothing is rebuilt per frame. Art is referenced
 * by sprite KEY and text by string -- resolving either to a GPU resource is the renderer's job, so
 * this file (like `layout.ts` and `hit.ts`) imports no three.js and needs no WebGL to exercise.
 *
 * `drawList` is the single ordered list of what is on screen. Both the renderer and the hit-test
 * consume it, which is what guarantees the thing you click is the thing you see.
 */
import { Anchor, LayoutNode, Rect, resolveAnchors, Viewport } from './layout';

/** Draw layers, back to front -- FrameXML's own ladder plus a DIALOG layer above everything. */
export type Layer = 'BACKGROUND' | 'BORDER' | 'ARTWORK' | 'OVERLAY' | 'HIGHLIGHT' | 'DIALOG';

export const LAYER_ORDER: Layer[] = [
  'BACKGROUND',
  'BORDER',
  'ARTWORK',
  'OVERLAY',
  'HIGHLIGHT',
  'DIALOG',
];

/** Normal alpha, or the ADD blend the glowing glue art is authored for. */
export type Blend = 'ALPHA' | 'ADD';

/** A sub-rectangle of a sprite sheet, as fractions. `v0` is the TOP edge. */
export type TexCoords = { u0: number; v0: number; u1: number; v1: number };

export type WidgetKind =
  | 'frame'
  | 'texture'
  | 'fontstring'
  | 'button'
  | 'editbox'
  | 'checkbutton'
  | 'backdrop';

export type ButtonState = 'up' | 'down' | 'disabled';

export interface FontSpec {
  /** A font family registered by `text.ts` -- e.g. 'FRIZQT', 'MORPHEUS', 'SKURRI'. */
  family: string;
  /** Logical units. */
  size: number;
  color: string;
  /** Draw the client's 1px outline ring. */
  outline: boolean;
  align: 'LEFT' | 'CENTER' | 'RIGHT';
}

let nextWidgetId = 0;

export class Widget {
  readonly id: string;
  readonly kind: WidgetKind;

  parent: Widget | null = null;
  readonly children: Widget[] = [];

  layer: Layer = 'ARTWORK';
  anchors: Anchor[] = [];
  width = 0;
  height = 0;

  shown = true;
  alpha = 1;
  mouseEnabled = false;
  focusable = false;

  /** Sprite key resolved by `GlueArt`; null draws nothing. */
  sprite: string | null = null;
  texCoords: TexCoords | null = null;
  blend: Blend = 'ALPHA';
  /** Multiplied into the sprite, as `#rrggbb`. */
  vertexColor = '#ffffff';

  text = '';
  font: FontSpec | null = null;

  /** Button/checkbutton state. `hovered` is written by the input router. */
  state: ButtonState = 'up';
  hovered = false;
  checked = false;

  /** EditBox state. */
  maxLetters = 0;
  password = false;
  caret = 0;

  /** Per-widget click handler, invoked by the input router. */
  onClick: (() => void) | null = null;

  constructor(kind: WidgetKind, id?: string) {
    this.kind = kind;
    this.id = id ?? `${kind}-${nextWidgetId++}`;
  }

  add(child: Widget): Widget {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(child: Widget): void {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parent = null;
    }
  }

  setAnchors(...anchors: Anchor[]): Widget {
    this.anchors = anchors;
    return this;
  }

  setSize(width: number, height: number): Widget {
    this.width = width;
    this.height = height;
    return this;
  }

  show(): void {
    this.shown = true;
  }

  hide(): void {
    this.shown = false;
  }

  /** Shown only if every ancestor is too. */
  get visible(): boolean {
    let node: Widget | null = this;
    while (node) {
      if (!node.shown) {
        return false;
      }
      node = node.parent;
    }
    return true;
  }
}

export interface DrawItem {
  widget: Widget;
  rect: Rect;
  /** The widget's alpha multiplied down the ancestor chain. */
  alpha: number;
}

export class WidgetRoot {
  readonly root = new Widget('frame', 'root');

  constructor() {
    // The root always fills the window, so a child with no anchors still resolves.
    this.root.setAnchors(
      { point: 'TOPLEFT', x: 0, y: 0 },
      { point: 'BOTTOMRIGHT', x: 0, y: 0 },
    );
  }

  /**
   * Flatten to a back-to-front draw list with resolved rects.
   *
   * Order is layer first, then depth-first insertion order within a layer -- so a child in
   * OVERLAY draws above an unrelated parent's HIGHLIGHT only if the layer says so, never because of
   * where it sits in the tree. Hidden subtrees are skipped whole.
   */
  drawList(viewport: Viewport): DrawItem[] {
    const flat: Array<{ widget: Widget; alpha: number; sequence: number }> = [];
    const nodes: LayoutNode[] = [];
    let sequence = 0;

    const walk = (widget: Widget, alpha: number): void => {
      if (!widget.shown) {
        return;
      }

      const cumulative = alpha * widget.alpha;
      flat.push({ widget, alpha: cumulative, sequence: sequence++ });
      nodes.push({
        id: widget.id,
        width: widget.width,
        height: widget.height,
        anchors: widget.anchors,
      });

      for (const child of widget.children) {
        walk(child, cumulative);
      }
    };

    walk(this.root, 1);

    const rects = resolveAnchors(nodes, viewport);

    return flat
      .sort((a, b) => {
        const layers = LAYER_ORDER.indexOf(a.widget.layer) - LAYER_ORDER.indexOf(b.widget.layer);
        return layers !== 0 ? layers : a.sequence - b.sequence;
      })
      .map((entry) => ({
        widget: entry.widget,
        rect: rects.get(entry.widget.id)!,
        alpha: entry.alpha,
      }));
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd client && npx tsc --noEmit -p tsconfig.json`
Expected: no errors in `src/game/ui/widget.ts` (pre-existing errors elsewhere are not this task's concern — compare against a run on the previous commit if unsure).

- [ ] **Step 3: Commit**

```bash
git add client/src/game/ui/widget.ts
git commit -m "feat(ui): add the retained glue widget tree"
```

---

### Task 5: Hit-testing and focus

**Files:**
- Create: `client/src/game/ui/hit.ts`
- Test: `client/src/game/ui/__tests__/hit.test.ts`

**Interfaces:**
- Consumes: `DrawItem`, `Widget`, `WidgetRoot` from `./widget`.
- Produces: `hitTest(items, x, y): Widget | null`, `focusChain(items): Widget[]`, `nextFocus(chain, current, backwards?): Widget | null`.

- [ ] **Step 1: Write the failing test**

```ts
import { focusChain, hitTest, nextFocus } from '../hit';
import { Widget, WidgetRoot } from '../widget';

const viewport = { width: 1024, height: 768 };

function tree() {
  const root = new WidgetRoot();

  const back = root.root.add(new Widget('texture', 'back'));
  back.layer = 'BACKGROUND';
  back.mouseEnabled = true;
  back.setSize(400, 400).setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });

  const front = root.root.add(new Widget('button', 'front'));
  front.layer = 'ARTWORK';
  front.mouseEnabled = true;
  front.focusable = true;
  front.setSize(100, 40).setAnchors({ point: 'TOPLEFT', x: 50, y: -50 });

  const decoration = root.root.add(new Widget('texture', 'decoration'));
  decoration.layer = 'OVERLAY';
  // Deliberately NOT mouse-enabled: art on top of a button must not eat its clicks.
  decoration.setSize(100, 40).setAnchors({ point: 'TOPLEFT', x: 50, y: -50 });

  const box = root.root.add(new Widget('editbox', 'box'));
  box.layer = 'ARTWORK';
  box.mouseEnabled = true;
  box.focusable = true;
  box.setSize(200, 32).setAnchors({ point: 'TOPLEFT', x: 50, y: -200 });

  return root;
}

describe('hitTest', () => {
  it('returns the top-most mouse-enabled widget', () => {
    const items = tree().drawList(viewport);

    expect(hitTest(items, 60, 60)!.id).toBe('front');
  });

  it('falls through art that is not mouse-enabled', () => {
    const root = tree();
    // Make the decoration cover the button entirely; it still must not be hit.
    const items = root.drawList(viewport);
    const hit = hitTest(items, 100, 70);

    expect(hit!.id).toBe('front');
  });

  it('returns the widget beneath when nothing above is hit', () => {
    const items = tree().drawList(viewport);

    expect(hitTest(items, 10, 300)!.id).toBe('back');
  });

  it('returns null outside every widget', () => {
    const items = tree().drawList(viewport);

    expect(hitTest(items, 900, 700)).toBeNull();
  });

  it('ignores hidden widgets', () => {
    const root = tree();
    root.root.children.find((child) => child.id === 'front')!.hide();
    const items = root.drawList(viewport);

    expect(hitTest(items, 60, 60)!.id).toBe('back');
  });
});

describe('focus', () => {
  it('chains focusable widgets in draw order', () => {
    const items = tree().drawList(viewport);

    expect(focusChain(items).map((widget) => widget.id)).toEqual(['front', 'box']);
  });

  it('advances and wraps with Tab', () => {
    const chain = focusChain(tree().drawList(viewport));

    expect(nextFocus(chain, null)!.id).toBe('front');
    expect(nextFocus(chain, chain[0])!.id).toBe('box');
    expect(nextFocus(chain, chain[1])!.id).toBe('front');
  });

  it('walks backwards with Shift+Tab', () => {
    const chain = focusChain(tree().drawList(viewport));

    expect(nextFocus(chain, chain[0], true)!.id).toBe('box');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=ui/__tests__/hit`
Expected: FAIL — cannot resolve `../hit`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Hit-testing and focus over a widget draw list.
 *
 * Reads the SAME ordered list the renderer draws, walked backwards -- the top-most drawn
 * mouse-enabled widget wins. Pure: no DOM, no three.js. `input.ts` owns the events; this file only
 * answers "what is under this point" and "what gets focus next".
 */
import { DrawItem, Widget } from './widget';

function contains(item: DrawItem, x: number, y: number): boolean {
  const { left, top, width, height } = item.rect;
  return x >= left && x < left + width && y >= top && y < top + height;
}

/**
 * The top-most mouse-enabled widget at a point, in logical units, or null.
 *
 * Art that is not `mouseEnabled` is transparent to the mouse even when it draws on top -- which is
 * how a highlight or border over a button keeps the button clickable.
 */
export function hitTest(items: DrawItem[], x: number, y: number): Widget | null {
  for (let index = items.length - 1; index >= 0; --index) {
    const item = items[index];
    if (item.widget.mouseEnabled && contains(item, x, y)) {
      return item.widget;
    }
  }
  return null;
}

/** Focusable widgets in draw order -- the Tab ring. */
export function focusChain(items: DrawItem[]): Widget[] {
  return items.filter((item) => item.widget.focusable).map((item) => item.widget);
}

/** The next focus target, wrapping. `current` of null starts at the first (or last, backwards). */
export function nextFocus(
  chain: Widget[],
  current: Widget | null,
  backwards = false,
): Widget | null {
  if (chain.length === 0) {
    return null;
  }

  const index = current ? chain.indexOf(current) : -1;
  if (index < 0) {
    return backwards ? chain[chain.length - 1] : chain[0];
  }

  const step = backwards ? -1 : 1;
  return chain[(index + step + chain.length) % chain.length];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=ui/__tests__/hit`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/ui/hit.ts client/src/game/ui/__tests__/hit.test.ts
git commit -m "feat(ui): add glue hit-testing and focus chain"
```

---

### Task 6: Quad materials and the UI render pass

**Files:**
- Create: `client/src/game/ui/material.ts`
- Create: `client/src/game/ui/renderer.ts`

**Interfaces:**
- Consumes: `DrawItem` from `./widget`, `viewportUnits` from `./layout`.
- Produces: `createQuadMaterial(blend: Blend): THREE.MeshBasicMaterial`, `applyTexCoords(material, texCoords)`, and `class GlueRenderer { constructor(renderer: THREE.WebGLRenderer); render(items: DrawItem[], resolve: SpriteResolver): void; dispose(): void }` where `type SpriteResolver = (item: DrawItem) => THREE.Texture | null`. Later tasks pass a resolver backed by `GlueArt` and `text.ts`.

- [ ] **Step 1: Write `material.ts`**

```ts
/**
 * The two glue blend modes.
 *
 * Unlit, depth-test off, drawn in the order the draw list dictates. ADD exists because a lot of
 * glue art is authored to glow (the reference needed a dedicated additive UI material for the same
 * reason: benilla `glue/add_material.rs`).
 */
import * as THREE from 'three';

import { Blend, TexCoords } from './widget';

export function createQuadMaterial(blend: Blend): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: blend === 'ADD' ? THREE.AdditiveBlending : THREE.NormalBlending,
    // Premultiplied would double-darken the client's straight-alpha art.
    premultipliedAlpha: false,
    side: THREE.FrontSide,
  });
}

/**
 * Point a material's map at a sub-rectangle of its sheet.
 *
 * No V flip. Two conventions cancel: `TextureLoader` creates every texture with `flipY = false`
 * (three.js cannot flip a compressed upload), so image row 0 is `v = 0`; and the UI's orthographic
 * camera is Y-DOWN, which puts the quad's `v = 0` edge at the TOP of the screen. Introduce a flip
 * here and every sprite draws upside down.
 */
export function applyTexCoords(
  material: THREE.MeshBasicMaterial,
  texCoords: TexCoords | null,
): void {
  const map = material.map;
  if (!map) {
    return;
  }

  if (!texCoords) {
    map.offset.set(0, 0);
    map.repeat.set(1, 1);
    return;
  }

  map.offset.set(texCoords.u0, texCoords.v0);
  map.repeat.set(texCoords.u1 - texCoords.u0, texCoords.v1 - texCoords.v0);
}
```

- [ ] **Step 2: Write `renderer.ts`**

```ts
/**
 * The UI render pass: one orthographic scene of textured quads, drawn over whatever the renderer
 * already has in the buffer.
 *
 * The widget layer never OWNS a renderer. It is handed one -- the glue host's now, the game's when
 * the in-world HUD is built on this same layer -- and draws with `autoClear = false` so the 3D glue
 * scene beneath it survives.
 *
 * Meshes are pooled per widget id: a glue screen mutates its tree, it does not rebuild it, so
 * allocating a quad per frame would be pure garbage.
 */
import * as THREE from 'three';

import { viewportUnits } from './layout';
import { applyTexCoords, createQuadMaterial } from './material';
import { DrawItem } from './widget';

export type SpriteResolver = (item: DrawItem) => THREE.Texture | null;

/** One unit quad, shared by every widget. Sub-rects come from the material's map offset/repeat. */
const QUAD = new THREE.PlaneGeometry(1, 1);

type Pooled = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
};

export class GlueRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000);
  private readonly pool = new Map<string, Pooled>();

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.scene.name = 'GlueUI';
  }

  render(items: DrawItem[], resolve: SpriteResolver): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    const units = viewportUnits({ width: size.x, height: size.y });

    // Y-DOWN: top = 0, bottom = height. Logical units, so widget rects map 1:1.
    this.camera.left = 0;
    this.camera.right = units.width;
    this.camera.top = 0;
    this.camera.bottom = units.height;
    this.camera.updateProjectionMatrix();

    const live = new Set<string>();

    items.forEach((item, index) => {
      const texture = resolve(item);
      if (!texture) {
        return;
      }

      live.add(item.widget.id);

      let entry = this.pool.get(item.widget.id);
      if (!entry) {
        const material = createQuadMaterial(item.widget.blend);
        const mesh = new THREE.Mesh(QUAD, material);
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        entry = { mesh, material };
        this.pool.set(item.widget.id, entry);
      }

      entry.material.map = texture;
      entry.material.blending =
        item.widget.blend === 'ADD' ? THREE.AdditiveBlending : THREE.NormalBlending;
      entry.material.opacity = item.alpha;
      entry.material.color.set(item.widget.vertexColor);
      entry.material.needsUpdate = true;
      applyTexCoords(entry.material, item.widget.texCoords);

      const { left, top, width, height } = item.rect;
      entry.mesh.position.set(left + width / 2, top + height / 2, 0);
      entry.mesh.scale.set(width, height, 1);
      // Draw order, not depth: depth testing is off and every quad sits at z = 0.
      entry.mesh.renderOrder = index;
      entry.mesh.visible = true;
    });

    // A widget that vanished this frame keeps its pooled mesh (screens re-show things constantly)
    // but must not draw.
    this.pool.forEach((entry, id) => {
      if (!live.has(id)) {
        entry.mesh.visible = false;
      }
    });

    const previousAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = previousAutoClear;
  }

  dispose(): void {
    this.pool.forEach((entry) => {
      this.scene.remove(entry.mesh);
      entry.material.dispose();
    });
    this.pool.clear();
  }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd client && npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/game/ui/material.ts client/src/game/ui/renderer.ts
git commit -m "feat(ui): add glue quad materials and the UI render pass"
```

---

### Task 7: Text — client fonts, outline, cached rasterization

**Files:**
- Create: `client/src/game/ui/text.ts`

**Interfaces:**
- Consumes: `FontSpec` from `./widget`; `Loader` from `../net/loader`.
- Produces: `loadGlueFonts(): Promise<void>`, `class FontStringTextures { get(text: string, spec: FontSpec, scale: number): THREE.CanvasTexture | null; dispose(): void }`, `measureText(text, spec, scale): {width, height}`.

- [ ] **Step 1: Write the implementation**

```ts
/**
 * Glue text: the client's own fonts, rasterized to a canvas texture.
 *
 * The reference had to fake the client's baked 1px outline with offset copies of every string
 * (benilla's `OutlineCopy`, because bevy has no text stroke). A 2D context gives us `strokeText`, so
 * we draw the ring for real -- closer to the reference with less machinery.
 *
 * Rasterization is cached by content AND by device scale: a glue screen changes its strings on
 * selection, not per frame, so a per-frame rasterize would be a frame-budget hole for nothing.
 */
import * as THREE from 'three';

import Loader from '../net/loader';
import { FontSpec } from './widget';

/** The client's shipped faces, by the family name widgets ask for. */
const FONT_FILES: Record<string, string> = {
  FRIZQT: 'Fonts\\FRIZQT__.TTF',
  MORPHEUS: 'Fonts\\MORPHEUS.TTF',
  SKURRI: 'Fonts\\SKURRI.TTF',
  ARIALN: 'Fonts\\ARIALN.TTF',
};

let fontsPromise: Promise<void> | null = null;

/**
 * Register the client fonts with the document. Idempotent, and safe to await more than once.
 *
 * A face that fails to arrive is logged and skipped rather than fatal -- a glue screen with the
 * wrong typeface is debuggable, a glue screen that never mounts is not.
 */
export function loadGlueFonts(): Promise<void> {
  if (fontsPromise) {
    return fontsPromise;
  }

  const loader = new Loader();

  fontsPromise = Promise.all(
    Object.entries(FONT_FILES).map(async ([family, path]) => {
      try {
        const data = await loader.load(path);
        const face = new FontFace(family, data);
        await face.load();
        (document as any).fonts.add(face);
      } catch (error) {
        console.warn(`glue font ${family} unavailable:`, error);
      }
    }),
  ).then(() => undefined);

  return fontsPromise;
}

function cssFont(spec: FontSpec, scale: number): string {
  return `${Math.round(spec.size * scale)}px "${spec.family}"`;
}

let measureContext: CanvasRenderingContext2D | null = null;

function sharedMeasureContext(): CanvasRenderingContext2D {
  if (!measureContext) {
    measureContext = document.createElement('canvas').getContext('2d')!;
  }
  return measureContext;
}

/** Logical-unit size of a rendered string. */
export function measureText(
  text: string,
  spec: FontSpec,
  scale: number,
): { width: number; height: number } {
  const context = sharedMeasureContext();
  context.font = cssFont(spec, scale);
  const metrics = context.measureText(text);
  return { width: metrics.width / scale, height: spec.size };
}

type Entry = { texture: THREE.CanvasTexture; key: string };

export class FontStringTextures {
  private readonly cache = new Map<string, Entry>();

  /**
   * The texture for one string. Null for empty text -- the renderer skips a widget with no texture,
   * which is exactly right for an empty label.
   */
  get(text: string, spec: FontSpec, scale: number): THREE.CanvasTexture | null {
    if (!text) {
      return null;
    }

    const key = [
      text,
      spec.family,
      spec.size,
      spec.color,
      spec.outline ? 'o' : '-',
      Math.round(scale * 100),
    ].join('|');

    const cached = this.cache.get(key);
    if (cached) {
      return cached.texture;
    }

    const font = cssFont(spec, scale);
    const context = sharedMeasureContext();
    context.font = font;
    const width = Math.ceil(context.measureText(text).width) + 4;
    const height = Math.ceil(spec.size * scale) + 6;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(width, 1);
    canvas.height = Math.max(height, 1);

    const target = canvas.getContext('2d')!;
    target.font = font;
    target.textBaseline = 'middle';
    target.textAlign = 'left';

    if (spec.outline) {
      // The client's baked ring: one device pixel, drawn as a real stroke.
      target.lineWidth = 2;
      target.lineJoin = 'round';
      target.strokeStyle = '#000000';
      target.strokeText(text, 2, canvas.height / 2);
    }

    target.fillStyle = spec.color;
    target.fillText(text, 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    // Match the BLP convention so `applyTexCoords` needs no special case: row 0 is v = 0.
    texture.flipY = false;
    texture.needsUpdate = true;

    this.cache.set(key, { texture, key });
    return texture;
  }

  dispose(): void {
    this.cache.forEach((entry) => entry.texture.dispose());
    this.cache.clear();
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd client && npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/game/ui/text.ts
git commit -m "feat(ui): render glue text with the client's own fonts"
```

---

### Task 8: The glue art table

**Files:**
- Create: `client/src/game/ui/art.ts`

**Interfaces:**
- Consumes: `TextureLoader` from `../pipeline/texture-loader`, `TexCoords` from `./widget`.
- Produces: `interface SpriteDef { path: string; texCoords?: TexCoords; size?: [number, number] }`, `class GlueArt { register(key, def): void; registerAll(table: Record<string, SpriteDef>): void; load(): Promise<void>; texture(key): THREE.Texture | null; def(key): SpriteDef | null }`, and `PROBE_ART` — the table Task 11's probe screen uses.

- [ ] **Step 1: Write the implementation**

```ts
/**
 * The glue art table: sprite keys to client-data textures.
 *
 * Screens name art by KEY and never by path, so every asset a screen needs is declarable in one
 * place and auditable at a glance. Fetch and decode go through the existing `TextureLoader` -- no
 * second cache, no second fetch path.
 */
import * as THREE from 'three';

import TextureLoader from '../pipeline/texture-loader';
import { TexCoords } from './widget';

export interface SpriteDef {
  /** MPQ-style path; the loader normalizes separators and case. */
  path: string;
  /** Sub-rectangle for an atlas sheet. Whole texture when absent. */
  texCoords?: TexCoords;
  /** Authored size in logical units, when the art has one. */
  size?: [number, number];
}

export class GlueArt {
  private readonly defs = new Map<string, SpriteDef>();
  private readonly textures = new Map<string, THREE.Texture>();

  register(key: string, def: SpriteDef): void {
    this.defs.set(key, def);
  }

  registerAll(table: Record<string, SpriteDef>): void {
    Object.entries(table).forEach(([key, def]) => this.register(key, def));
  }

  /**
   * Fetch every registered sprite. Clamped wrapping: glue art is stamped, never tiled, and
   * REPEAT on a sub-rect bleeds neighbouring sprites in along the seams.
   *
   * A sprite that fails to load is logged and left absent -- `texture()` returns null and the
   * renderer skips that quad, so one missing BLP costs one sprite rather than the screen.
   */
  async load(): Promise<void> {
    await Promise.all(
      Array.from(this.defs.entries()).map(async ([key, def]) => {
        if (this.textures.has(key)) {
          return;
        }
        try {
          const texture = await TextureLoader.load(
            def.path,
            THREE.ClampToEdgeWrapping,
            THREE.ClampToEdgeWrapping,
          );
          this.textures.set(key, texture);
        } catch (error) {
          console.warn(`glue art missing: ${key} (${def.path})`, error);
        }
      }),
    );
  }

  texture(key: string): THREE.Texture | null {
    return this.textures.get(key) ?? null;
  }

  def(key: string): SpriteDef | null {
    return this.defs.get(key) ?? null;
  }
}

/**
 * The art the throwaway probe screen draws (Task 11). Every path verified present on the asset
 * host. This table dies with the probe in spec 3, when the real `AccountLogin` table replaces it.
 */
export const PROBE_ART: Record<string, SpriteDef> = {
  logo: { path: 'Interface\\Glues\\Common\\Glues-WoW-Logo', size: [400, 200] },
  'button-up': { path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Up-Blue', size: [128, 32] },
  'button-down': { path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Down-Blue', size: [128, 32] },
  'button-highlight': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Highlight-Blue',
    size: [128, 32],
  },
  'editbox-left': { path: 'Interface\\ChatFrame\\UI-ChatInputBorder-Left', size: [128, 32] },
  'editbox-right': { path: 'Interface\\ChatFrame\\UI-ChatInputBorder-Right', size: [128, 32] },
  'dialog-background': { path: 'Interface\\DialogFrame\\UI-DialogBox-Background' },
  'dialog-border': { path: 'Interface\\DialogFrame\\UI-DialogBox-Border' },
};
```

- [ ] **Step 2: Verify it compiles**

Run: `cd client && npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/game/ui/art.ts
git commit -m "feat(ui): add the glue art table"
```

---

### Task 9: GlueStrings

**Files:**
- Create: `client/src/game/ui/strings.ts`
- Test: `client/src/game/ui/__tests__/strings.test.ts`

**Interfaces:**
- Consumes: `Loader` from `../net/loader`.
- Produces: `parseGlueStrings(source: string): Map<string, string>`, `class GlueStrings { static load(): Promise<GlueStrings>; get(key: string): string; format(key: string, ...args): string; has(key): boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
import { GlueStrings, parseGlueStrings } from '../strings';

/** A verbatim excerpt of the shipped 3.3.5 `interface/gluexml/gluestrings.lua`. */
const EXCERPT = `
ACCOUNT_CREATE_FAILED = "Account creation failed";
ACCOUNT_NAME = "Battle.net Account Name";
ADDON_UPDATE_AVAILABLE = "New version is available\\n";
AUTH_INCORRECT_PASSWORD = "Incorrect Password";
AUTH_UNKNOWN_ACCOUNT = "Unknown account";
BATTLEFIELD_ALERT = "You are eligible to enter %s You will be removed from the queue in %s";
-- a comment line that is not an assignment
CharacterSelectString = "not upper case but still a key";
`;

describe('parseGlueStrings', () => {
  it('reads plain assignments', () => {
    const table = parseGlueStrings(EXCERPT);

    expect(table.get('AUTH_UNKNOWN_ACCOUNT')).toBe('Unknown account');
    expect(table.get('ACCOUNT_NAME')).toBe('Battle.net Account Name');
  });

  it('unescapes newlines', () => {
    const table = parseGlueStrings(EXCERPT);

    expect(table.get('ADDON_UPDATE_AVAILABLE')).toBe('New version is available\n');
  });

  it('keeps %s placeholders intact', () => {
    const table = parseGlueStrings(EXCERPT);

    expect(table.get('BATTLEFIELD_ALERT')).toContain('%s');
  });

  it('skips comments and takes mixed-case keys', () => {
    const table = parseGlueStrings(EXCERPT);

    expect(table.has('--')).toBe(false);
    expect(table.get('CharacterSelectString')).toBe('not upper case but still a key');
  });
});

describe('GlueStrings', () => {
  it('substitutes positional placeholders in order', () => {
    const strings = new GlueStrings(parseGlueStrings(EXCERPT));

    expect(strings.format('BATTLEFIELD_ALERT', 'Warsong Gulch', '2 minutes')).toBe(
      'You are eligible to enter Warsong Gulch You will be removed from the queue in 2 minutes',
    );
  });

  it('returns the key itself for a missing string, so a gap is visible not blank', () => {
    const strings = new GlueStrings(parseGlueStrings(EXCERPT));

    expect(strings.get('NO_SUCH_KEY')).toBe('NO_SUCH_KEY');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=ui/__tests__/strings`
Expected: FAIL — cannot resolve `../strings`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * GlueStrings: the client's own UI text.
 *
 * No screen in this subsystem may hardcode a user-visible string. Everything the player reads comes
 * from `interface/gluexml/gluestrings.lua` -- including error text, so a server result code shows
 * the client's own wording (`AUTH_*`, `CHAR_CREATE_*`) rather than ours.
 */
import Loader from '../net/loader';

const ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*;?/;

const ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
};

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_, char) => ESCAPES[char] ?? char);
}

/** Parse the shipped Lua string table. Anything that is not a `KEY = "value"` line is ignored. */
export function parseGlueStrings(source: string): Map<string, string> {
  const table = new Map<string, string>();

  for (const line of source.split('\n')) {
    const match = ASSIGNMENT.exec(line);
    if (match) {
      table.set(match[1], unescape(match[2]));
    }
  }

  return table;
}

export class GlueStrings {
  private readonly table: Map<string, string>;

  constructor(table: Map<string, string>) {
    this.table = table;
  }

  static async load(): Promise<GlueStrings> {
    const raw = await new Loader().load('Interface\\GlueXML\\GlueStrings.lua');
    const source = new TextDecoder('utf-8').decode(raw);
    return new GlueStrings(parseGlueStrings(source));
  }

  has(key: string): boolean {
    return this.table.has(key);
  }

  /** The string, or the key itself when absent -- a missing string must be VISIBLE, not blank. */
  get(key: string): string {
    return this.table.get(key) ?? key;
  }

  /** Substitute `%s`/`%d` placeholders positionally, as the client's `format` does. */
  format(key: string, ...args: Array<string | number>): string {
    let index = 0;
    return this.get(key).replace(/%[sd]/g, () => String(args[index++] ?? ''));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=ui/__tests__/strings`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/ui/strings.ts client/src/game/ui/__tests__/strings.test.ts
git commit -m "feat(ui): read UI text from the client's GlueStrings"
```

---

### Task 10: Input routing

**Files:**
- Create: `client/src/game/ui/input.ts`

**Interfaces:**
- Consumes: `hitTest`, `focusChain`, `nextFocus` from `./hit`; `DrawItem`, `Widget` from `./widget`; `viewportUnits` from `./layout`.
- Produces: `class GlueInput { constructor(canvas: HTMLCanvasElement); setDrawList(items: DrawItem[]): void; attach(): void; detach(): void; get focused(): Widget | null; setFocus(widget: Widget | null): void }`. `GlueInput` mutates `widget.hovered`, `widget.state`, `widget.text` and `widget.caret`, and invokes `widget.onClick`.

- [ ] **Step 1: Write the implementation**

```ts
/**
 * Input routing: DOM events on the canvas to widget state.
 *
 * Pointer coordinates convert to logical units and go through `hitTest` on the same draw list the
 * renderer used, so what the player clicks is what the player sees. Press CAPTURE matters: a press
 * that drags off a button and releases elsewhere must not fire the click, and must still clear the
 * pressed art.
 *
 * Text entry is a real edit box -- printable keys, backspace/delete, arrows, home/end and paste. In
 * a browser paste is a `paste` event; the reference needed a whole host-clipboard module for this.
 */
import { focusChain, hitTest, nextFocus } from './hit';
import { viewportUnits } from './layout';
import { DrawItem, Widget } from './widget';

export class GlueInput {
  private readonly canvas: HTMLCanvasElement;
  private items: DrawItem[] = [];
  private pressed: Widget | null = null;
  private hovered: Widget | null = null;
  private focus: Widget | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  setDrawList(items: DrawItem[]): void {
    this.items = items;
  }

  get focused(): Widget | null {
    return this.focus;
  }

  setFocus(widget: Widget | null): void {
    if (this.focus === widget) {
      return;
    }
    this.focus = widget;
    if (widget && widget.kind === 'editbox') {
      widget.caret = widget.text.length;
    }
  }

  attach(): void {
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('paste', this.onPaste);
  }

  detach(): void {
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('paste', this.onPaste);
  }

  /** Canvas-relative pixels to logical units. */
  private toUnits(event: PointerEvent): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    const units = viewportUnits({ width: bounds.width, height: bounds.height });
    const scale = bounds.height / units.height;
    return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
  }

  private onPointerMove = (event: PointerEvent): void => {
    const { x, y } = this.toUnits(event);
    const hit = hitTest(this.items, x, y);

    if (this.hovered !== hit) {
      if (this.hovered) {
        this.hovered.hovered = false;
      }
      if (hit) {
        hit.hovered = true;
      }
      this.hovered = hit;
    }

    if (this.pressed) {
      // Pressed art follows the pointer being over the widget, as the reference's buttons do.
      this.pressed.state = this.pressed === hit ? 'down' : 'up';
    }
  };

  private onPointerDown = (event: PointerEvent): void => {
    const { x, y } = this.toUnits(event);
    const hit = hitTest(this.items, x, y);

    this.setFocus(hit && hit.focusable ? hit : null);

    if (hit && hit.state !== 'disabled') {
      this.pressed = hit;
      hit.state = 'down';
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    const pressed = this.pressed;
    this.pressed = null;
    if (!pressed) {
      return;
    }

    pressed.state = 'up';

    const { x, y } = this.toUnits(event as PointerEvent);
    if (hitTest(this.items, x, y) !== pressed) {
      return; // Released off the widget: no click.
    }

    if (pressed.kind === 'checkbutton') {
      pressed.checked = !pressed.checked;
    }
    pressed.onClick?.();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') {
      event.preventDefault();
      this.setFocus(nextFocus(focusChain(this.items), this.focus, event.shiftKey));
      return;
    }

    const target = this.focus;
    if (!target) {
      return;
    }

    if (event.key === 'Enter' || event.key === 'Escape') {
      // The screen decides what submit/cancel mean; it reads these off the focused widget.
      target.onClick?.();
      return;
    }

    if (target.kind !== 'editbox') {
      return;
    }

    if (event.key === 'Backspace') {
      if (target.caret > 0) {
        target.text = target.text.slice(0, target.caret - 1) + target.text.slice(target.caret);
        target.caret -= 1;
      }
    } else if (event.key === 'Delete') {
      target.text = target.text.slice(0, target.caret) + target.text.slice(target.caret + 1);
    } else if (event.key === 'ArrowLeft') {
      target.caret = Math.max(0, target.caret - 1);
    } else if (event.key === 'ArrowRight') {
      target.caret = Math.min(target.text.length, target.caret + 1);
    } else if (event.key === 'Home') {
      target.caret = 0;
    } else if (event.key === 'End') {
      target.caret = target.text.length;
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      this.insert(target, event.key);
    } else {
      return;
    }

    event.preventDefault();
  };

  private onPaste = (event: ClipboardEvent): void => {
    const target = this.focus;
    if (!target || target.kind !== 'editbox') {
      return;
    }
    const text = event.clipboardData?.getData('text') ?? '';
    if (text) {
      this.insert(target, text.replace(/\s+/g, ' '));
      event.preventDefault();
    }
  };

  /** Insert at the caret, honouring the box's `letters` cap. */
  private insert(target: Widget, text: string): void {
    const room = target.maxLetters > 0 ? target.maxLetters - target.text.length : text.length;
    const slice = text.slice(0, Math.max(0, room));
    if (!slice) {
      return;
    }
    target.text = target.text.slice(0, target.caret) + slice + target.text.slice(target.caret);
    target.caret += slice.length;
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd client && npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/game/ui/input.ts
git commit -m "feat(ui): route pointer, keyboard and paste into widgets"
```

---

### Task 11: The screen machine, the React host, and the probe screen

First visual milestone: `/glue` draws real client art with a working button, edit box and dialog.

**Files:**
- Create: `client/src/game/ui/screens.ts`
- Create: `client/src/game/ui/screens/probe.ts`
- Create: `client/src/pages/glue/index.tsx`
- Modify: `client/src/app.tsx` (add the `/glue` route)

**Interfaces:**
- Consumes: everything from Tasks 3–10.
- Produces: `enum ClientState { Login, RealmList, CharSelect, CharCreate, InWorld }`, `interface GlueContext { root: WidgetRoot; art: GlueArt; strings: GlueStrings; input: GlueInput; go(state: ClientState): void }`, `interface GlueScreen { mount(ctx): void; update(dt: number): void; unmount(): void }`, `class GlueApp { constructor(canvas); start(initial: ClientState): Promise<void>; stop(): void; register(state: ClientState, screen: GlueScreen): void }`.

- [ ] **Step 1: Write `screens.ts`**

```ts
/**
 * The client lifecycle machine and the glue app loop.
 *
 * `ClientState` mirrors the reference's own (benilla `char_select/mod.rs`): the pre-world glue
 * layer and the world are STATES, not routes -- which is why a screen never navigates, it asks the
 * machine to change state.
 *
 * A screen is a plain module. It knows nothing about React, routing, or the other screens.
 */
import * as THREE from 'three';

import { GlueArt } from './art';
import { GlueInput } from './input';
import { GlueRenderer } from './renderer';
import { GlueStrings } from './strings';
import { FontStringTextures, loadGlueFonts } from './text';
import { DrawItem, WidgetRoot } from './widget';
import { screenScale } from './layout';

export enum ClientState {
  Login = 'Login',
  RealmList = 'RealmList',
  CharSelect = 'CharSelect',
  CharCreate = 'CharCreate',
  InWorld = 'InWorld',
}

export interface GlueContext {
  root: WidgetRoot;
  art: GlueArt;
  strings: GlueStrings;
  input: GlueInput;
  /** Request a state change; takes effect before the next frame. */
  go(state: ClientState): void;
}

export interface GlueScreen {
  mount(ctx: GlueContext): void;
  update(dt: number): void;
  unmount(): void;
}

export class GlueApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly ui: GlueRenderer;
  private readonly fonts = new FontStringTextures();
  private readonly art = new GlueArt();
  private readonly input: GlueInput;

  private strings: GlueStrings | null = null;
  private screens = new Map<ClientState, GlueScreen>();
  private current: { state: ClientState; screen: GlueScreen; root: WidgetRoot } | null = null;
  private pending: ClientState | null = null;

  private frame = 0;
  private lastTime = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.ui = new GlueRenderer(this.renderer);
    this.input = new GlueInput(canvas);
  }

  register(state: ClientState, screen: GlueScreen): void {
    this.screens.set(state, screen);
  }

  async start(initial: ClientState): Promise<void> {
    this.resize();
    window.addEventListener('resize', this.resize);
    this.input.attach();

    // Fonts and strings first: a screen that mounts before them draws unreadable labels.
    await Promise.all([loadGlueFonts(), GlueStrings.load().then((s) => (this.strings = s))]);

    this.enter(initial);
    this.lastTime = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.resize);
    this.input.detach();
    this.current?.screen.unmount();
    this.current = null;
    this.ui.dispose();
    this.fonts.dispose();
    this.renderer.dispose();
  }

  private resize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  };

  private enter(state: ClientState): void {
    const screen = this.screens.get(state);
    if (!screen) {
      console.warn(`no glue screen registered for ${state}`);
      return;
    }

    this.current?.screen.unmount();

    const root = new WidgetRoot();
    const ctx: GlueContext = {
      root,
      art: this.art,
      strings: this.strings!,
      input: this.input,
      go: (next) => {
        this.pending = next;
      },
    };

    screen.mount(ctx);
    this.current = { state, screen, root };
  }

  private tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);

    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      this.enter(next);
    }

    if (!this.current) {
      return;
    }

    this.current.screen.update(dt);

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const items = this.current.root.drawList(viewport);
    this.input.setDrawList(items);

    this.renderer.clear();
    this.ui.render(items, (item) => this.resolveSprite(item, screenScale(viewport.height)));
  };

  /** A widget's texture: a font string rasterizes, everything else comes from the art table. */
  private resolveSprite(item: DrawItem, scale: number): THREE.Texture | null {
    const widget = item.widget;

    if (widget.kind === 'fontstring') {
      return widget.font ? this.fonts.get(widget.text, widget.font, scale) : null;
    }

    return widget.sprite ? this.art.texture(widget.sprite) : null;
  }
}
```

- [ ] **Step 2: Write `screens/probe.ts`**

```ts
/**
 * THROWAWAY proof screen. Deleted in spec 3, when the transcribed `AccountLogin` replaces it.
 *
 * Its whole job is to exercise the foundation against real client data: an ADD-blended logo, a
 * three-state button, an edit box that takes typing and paste, an outlined font string, and a
 * dialog on the DIALOG layer. Nothing here is authored layout -- do not treat it as reference.
 */
import { PROBE_ART } from '../art';
import { ClientState, GlueContext, GlueScreen } from '../screens';
import { FontSpec, Widget } from '../widget';

const LABEL: FontSpec = {
  family: 'FRIZQT',
  size: 14,
  color: '#ffd100',
  outline: true,
  align: 'CENTER',
};

export class ProbeScreen implements GlueScreen {
  private ctx: GlueContext | null = null;
  private dialog: Widget | null = null;
  private box: Widget | null = null;
  private boxText: Widget | null = null;
  private button: Widget | null = null;

  mount(ctx: GlueContext): void {
    this.ctx = ctx;
    ctx.art.registerAll(PROBE_ART);
    void ctx.art.load();

    const logo = ctx.root.root.add(new Widget('texture', 'probe-logo'));
    logo.layer = 'BACKGROUND';
    logo.sprite = 'logo';
    logo.blend = 'ADD';
    logo.setSize(400, 200).setAnchors({ point: 'TOP', x: 0, y: -40 });

    const box = ctx.root.root.add(new Widget('editbox', 'probe-editbox'));
    box.layer = 'ARTWORK';
    box.sprite = 'editbox-left';
    box.mouseEnabled = true;
    box.focusable = true;
    box.maxLetters = 16;
    box.setSize(200, 32).setAnchors({ point: 'CENTER', x: 0, y: 40 });

    const boxText = box.add(new Widget('fontstring', 'probe-editbox-text'));
    boxText.layer = 'OVERLAY';
    boxText.font = { ...LABEL, color: '#ffffff', align: 'LEFT' };
    boxText.setSize(190, 16).setAnchors({
      point: 'LEFT',
      relativeTo: 'probe-editbox',
      relativePoint: 'LEFT',
      x: 8,
      y: 0,
    });

    const button = ctx.root.root.add(new Widget('button', 'probe-button'));
    button.layer = 'ARTWORK';
    button.sprite = 'button-up';
    button.mouseEnabled = true;
    button.focusable = true;
    button.setSize(128, 32).setAnchors({ point: 'CENTER', x: 0, y: -20 });
    button.onClick = () => this.dialog?.show();

    const caption = button.add(new Widget('fontstring', 'probe-button-caption'));
    caption.layer = 'OVERLAY';
    caption.font = LABEL;
    caption.text = ctx.strings.get('OKAY');
    caption.setSize(128, 16).setAnchors({
      point: 'CENTER',
      relativeTo: 'probe-button',
      relativePoint: 'CENTER',
      x: 0,
      y: 0,
    });

    this.dialog = ctx.root.root.add(new Widget('backdrop', 'probe-dialog'));
    this.dialog.layer = 'DIALOG';
    this.dialog.sprite = 'dialog-background';
    this.dialog.mouseEnabled = true;
    this.dialog.setSize(300, 120).setAnchors({ point: 'CENTER', x: 0, y: 0 });
    this.dialog.onClick = () => this.dialog?.hide();
    this.dialog.hide();

    const dialogText = this.dialog.add(new Widget('fontstring', 'probe-dialog-text'));
    dialogText.layer = 'DIALOG';
    dialogText.font = LABEL;
    dialogText.text = ctx.strings.get('CANCEL');
    dialogText.setSize(280, 16).setAnchors({
      point: 'CENTER',
      relativeTo: 'probe-dialog',
      relativePoint: 'CENTER',
      x: 0,
      y: 0,
    });

    this.boxText = boxText;
    this.box = box;
    this.button = button;
  }

  update(): void {
    if (this.box && this.boxText) {
      this.boxText.text = this.box.text;
    }
    if (this.button) {
      // Three-state art, as the reference's buttons swap it.
      this.button.sprite =
        this.button.state === 'down'
          ? 'button-down'
          : this.button.hovered
            ? 'button-highlight'
            : 'button-up';
    }
  }

  unmount(): void {
    this.ctx = null;
    this.box = null;
    this.boxText = null;
    this.button = null;
    this.dialog = null;
  }
}

/** The state the probe stands in for while spec 3's real login screen does not exist yet. */
export const PROBE_STATE = ClientState.Login;
```

- [ ] **Step 3: Write the React host `pages/glue/index.tsx`**

```tsx
/**
 * The glue host: a full-window canvas and nothing else.
 *
 * React's entire role in the pre-world screens is this component. Widgets, input and state live in
 * `game/ui`, so there is no React state here to keep in step with the glue tree.
 */
import React from 'react';

import { ClientState, GlueApp } from '../../game/ui/screens';
import { ProbeScreen, PROBE_STATE } from '../../game/ui/screens/probe';

class GlueHost extends React.Component {
  private canvas = React.createRef<HTMLCanvasElement>();
  private app: GlueApp | null = null;

  componentDidMount(): void {
    const canvas = this.canvas.current;
    if (!canvas) {
      return;
    }

    this.app = new GlueApp(canvas);
    this.app.register(PROBE_STATE, new ProbeScreen());
    void this.app.start(PROBE_STATE);
  }

  componentWillUnmount(): void {
    this.app?.stop();
    this.app = null;
  }

  render(): React.ReactNode {
    return (
      <canvas
        ref={this.canvas}
        style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />
    );
  }
}

export default GlueHost;
```

- [ ] **Step 4: Add the route in `client/src/app.tsx`**

Add the import and one route entry. `/glue` deliberately does NOT replace `/` yet: `/`, `/realms` and `/characters` keep working, so foundation work never breaks the path into the world. Spec 3 moves the glue app onto `/`.

```tsx
import GlueHost from './pages/glue';
```

```tsx
    {
      // The glue app -- the in-canvas pre-world screens. Spec 3 moves this onto "/" when the
      // transcribed AccountLogin replaces the probe screen.
      path: "/glue",
      element: <GlueHost />
    },
```

- [ ] **Step 5: Verify by hand**

Run: `cd client && npm start`, open `http://localhost:3000/glue`.
Expected, all four to be checked off explicitly:
1. The WoW logo draws from real client art, additively blended.
2. The button swaps up/highlight/down art on hover and press; releasing ON it opens the dialog; releasing off it does not.
3. Clicking the edit box focuses it; typing shows text capped at 16 characters; Ctrl+V pastes; Tab moves focus between box and button.
4. Resize the window tall, then short (~680px), then wide: everything scales with height and nothing clips off the bottom.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/ui/screens.ts client/src/game/ui/screens/probe.ts client/src/pages/glue/index.tsx client/src/app.tsx
git commit -m "feat(ui): host the glue screen machine on /glue with a probe screen"
```

---

### Task 12: Scene tokens and the scene rig

The pure half of the 3D work: which model a screen shows, and how our version's fog and light tables fold onto the M2 material's uniforms.

**Files:**
- Create: `client/src/game/ui/scene/tokens.ts`
- Create: `client/src/game/ui/scene/scene-rig.ts`
- Test: `client/src/game/ui/scene/__tests__/scene-rig.test.ts`

**Interfaces:**
- Consumes: `propProbeCoeffs` from `../../world/light/laws`, `packFogParams` from `../../world/light/fog`.
- Produces: from `tokens.ts` — `type GlueScene = { kind: 'mainmenu'; northrend: boolean } | { kind: 'race'; race: number }`, `sceneToken(scene): string`, `scenePath(scene): string`, `raceKey(race): string`; from `scene-rig.ts` — `RACE_LIGHTS`, `CHAR_MODEL_FOG`, `type RaceLightRow`, `foldRaceLights(rows): { ambient: RGB; probe: ProbeCoeffs }`, `fogTriple(key): { color: RGB; params: [number,number,number,number] } | null`, `verticalFov(diagonalFov, aspect): number`.

- [ ] **Step 1: Write the failing test**

```ts
import { sceneToken, scenePath } from '../tokens';
import {
  CHAR_MODEL_FOG,
  fogTriple,
  foldRaceLights,
  RACE_LIGHTS,
  verticalFov,
} from '../scene-rig';

describe('sceneToken', () => {
  it('maps the main menu, including the Northrend variant', () => {
    expect(sceneToken({ kind: 'mainmenu', northrend: false })).toBe('MainMenu');
    expect(sceneToken({ kind: 'mainmenu', northrend: true })).toBe('MainMenu_Northrend');
  });

  it('shares scenes the way the reference does', () => {
    // glueparent.lua's SetBackgroundModel mapping: Troll rides Orc's stage, Gnome rides Dwarf's.
    expect(sceneToken({ kind: 'race', race: 2 })).toBe('Orc');
    expect(sceneToken({ kind: 'race', race: 8 })).toBe('Orc');
    expect(sceneToken({ kind: 'race', race: 3 })).toBe('Dwarf');
    expect(sceneToken({ kind: 'race', race: 7 })).toBe('Dwarf');
    expect(sceneToken({ kind: 'race', race: 4 })).toBe('NightElf');
    expect(sceneToken({ kind: 'race', race: 5 })).toBe('Scourge');
    expect(sceneToken({ kind: 'race', race: 6 })).toBe('Tauren');
    expect(sceneToken({ kind: 'race', race: 1 })).toBe('Human');
  });

  it("builds the client's own model path", () => {
    expect(scenePath({ kind: 'race', race: 1 })).toBe(
      'Interface\\Glues\\Models\\UI_Human\\UI_Human.m2',
    );
  });
});

describe('fogTriple', () => {
  it('reads a CharModelFogInfo row', () => {
    const fog = fogTriple('SCOURGE')!;

    expect(fog.color).toEqual([0, 0.22, 0.22]);
    // near is always 0 in SetLighting; far comes from the row.
    expect(CHAR_MODEL_FOG.SCOURGE.far).toBe(26);
    expect(fog.params).toHaveLength(4);
  });

  it('has the dedicated CHARACTERSELECT row -- our select screen IS fogged', () => {
    // benilla found 1.12 renders select unfogged; 3.3.5 runs the same SetLighting for both screens
    // and ships this row. Where they disagree, our client data wins.
    expect(CHAR_MODEL_FOG.CHARACTERSELECT).toEqual({ r: 0.8, g: 0.65, b: 0.73, far: 222 });
  });

  it('returns null for a race with no row, which means ClearFog', () => {
    expect(fogTriple('NOSUCHRACE')).toBeNull();
  });
});

describe('foldRaceLights', () => {
  it('sums the ambient-only rows into ambient and the coloured rows into lobes', () => {
    const folded = foldRaceLights(RACE_LIGHTS.HUMAN);

    // Human row 1 is ambient 0.27 grey with a black diffuse; rows 2 and 3 are diffuse-only.
    expect(folded.ambient[0]).toBeCloseTo(0.27);
    expect(folded.probe).toHaveLength(7);
    folded.probe.forEach((row) => row.forEach((value) => expect(Number.isFinite(value)).toBe(true)));
  });

  it('folds every shipped race table to finite coefficients', () => {
    Object.values(RACE_LIGHTS).forEach((rows) => {
      const folded = foldRaceLights(rows);
      folded.probe.forEach((row) => row.forEach((v) => expect(Number.isFinite(v)).toBe(true)));
    });
  });

  it('skips a disabled row', () => {
    const row = [...RACE_LIGHTS.SCOURGE[0]] as typeof RACE_LIGHTS.SCOURGE[0];
    row[0] = 0;

    expect(foldRaceLights([row]).ambient).toEqual([0, 0, 0]);
  });
});

describe('verticalFov', () => {
  it("converts the diagonal FOV at 4:3 to the reference's 0.6x vertical", () => {
    // The client builds its projection from a DIAGONAL angle: half-angle = (fov/2)/sqrt(aspect^2+1),
    // so the full vertical angle at 4/3 is 0.6 * fov.
    expect(verticalFov(1, 4 / 3)).toBeCloseTo(0.6);
  });

  it('narrows vertically as the window widens, which reveals width', () => {
    expect(verticalFov(1, 16 / 9)).toBeLessThan(verticalFov(1, 4 / 3));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=scene-rig`
Expected: FAIL — cannot resolve `../tokens`.

- [ ] **Step 3: Write `tokens.ts`**

```ts
/**
 * Which glue background scene a screen shows.
 *
 * The mapping is the client's own (`glueparent.lua:376` `SetBackgroundModel`, plus
 * `accountlogin.lua:34-36` for the main menu's expansion variant). An enum rather than a fake race
 * id, because the login scene is not a race and the fog law forks on the kind.
 */
export type GlueScene =
  | { kind: 'mainmenu'; northrend: boolean }
  | { kind: 'race'; race: number };

/** ChrRaces ids to the scene each race's stage uses. */
const RACE_TOKENS: Record<number, string> = {
  1: 'Human',
  2: 'Orc',
  3: 'Dwarf',
  4: 'NightElf',
  5: 'Scourge',
  6: 'Tauren',
  7: 'Dwarf', // Gnome shares the Dwarf stage
  8: 'Orc',   // Troll shares the Orc stage
  10: 'BloodElf',
  11: 'Draenei',
};

/** The `UI_<token>` part of the model path, and the key into the fog/light tables. */
export function sceneToken(scene: GlueScene): string {
  if (scene.kind === 'mainmenu') {
    return scene.northrend ? 'MainMenu_Northrend' : 'MainMenu';
  }
  return RACE_TOKENS[scene.race] ?? 'Human';
}

/** `Interface\Glues\Models\UI_<token>\UI_<token>.m2` -- the client's own path construction. */
export function scenePath(scene: GlueScene): string {
  const token = sceneToken(scene);
  return `Interface\\Glues\\Models\\UI_${token}\\UI_${token}.m2`;
}

/** The upper-case key `CharModelFogInfo` and `RaceLights` are indexed by. */
export function raceKey(race: number): string {
  return (RACE_TOKENS[race] ?? 'Human').toUpperCase();
}
```

- [ ] **Step 4: Write `scene-rig.ts`**

```ts
/**
 * The glue scene's fog and light rig, folded for the M2 material's uniforms.
 *
 * TRANSCRIBED FROM OUR CLIENT DATA (`interface/gluexml/glueparent.lua`), and this is where 3.3.5
 * parts company with the 1.12 reference. `glueparent.lua:50` says it outright: "RaceLights[]
 * duplicates the 3.2.2 color values in the models. Henceforth, the models no longer contain
 * directional lights", and `:361` adds that the engine "pulls the default point lights from the
 * models". So the DIRECTIONALS come from the table below and only the POINT lights come from the
 * M2 -- where benilla folds the model's own directional rig, we fold this.
 *
 * Row layout (13 numbers, `AddLight(index, unpack(row))`):
 *   [0] enabled  [1] light slot  [2..4] direction  [5] ambient intensity
 *   [6..8] ambient colour  [9] diffuse intensity  [10..12] diffuse colour
 * Read off the shipped values: Human row 1 is a straight-down light with 0.27 grey ambient and a
 * black diffuse; rows 2 and 3 are ambient-black with coloured diffuse at intensity 1 and 2.
 */
import { packFogParams } from '../../world/light/fog';
import { propProbeCoeffs, ProbeCoeffs, RGB, Vec3 } from '../../world/light/laws';

export type RaceLightRow = [
  number, number,
  number, number, number,
  number,
  number, number, number,
  number,
  number, number, number,
];

/** `glueparent.lua:51` -- verbatim. */
export const RACE_LIGHTS: Record<string, RaceLightRow[]> = {
  HUMAN: [
    [1, 0, 0, 0, -1, 1.0, 0.27, 0.27, 0.27, 1.0, 0, 0, 0],
    [1, 0, -0.45756075, -0.58900136, -0.66611975, 1.0, 0, 0, 0, 1.0, 0.19882353, 0.34921569, 0.43588236],
    [1, 0, -0.64623469, 0.57582057, -0.50081086, 1.0, 0, 0, 0, 2.0, 0.52196085, 0.44, 0.29764709],
  ],
  ORC: [
    [1, 0, 0, 0, -1, 1.0, 0.15, 0.15, 0.15, 1.0, 0, 0, 0],
    [1, 0, -0.74919, 0.35208, -0.56103, 1.0, 0, 0, 0, 1.0, 0.44706, 0.5451, 0.73725],
    [1, 0, 0.53162, -0.8434, 0.0778, 1.0, 0, 0, 0, 2.0, 0.55, 0.338625, 0.148825],
  ],
  DWARF: [
    [1, 0, 0, 0, -1, 1.0, 0.3, 0.3, 0.3, 0.0, 0, 0, 0],
    [1, 0, -0.88314, 0.42916, -0.18945, 1.0, 0, 0, 0, 2.0, 0.44706, 0.67451, 0.760785],
  ],
  TAUREN: [
    [1, 0, -0.48073, 0.71827, -0.50297, 1.0, 0, 0, 0, 2.0, 0.65, 0.397645, 0.2727],
    [1, 0, -0.49767, -0.78677, 0.36513, 1.0, 0, 0, 0, 1.0, 0.6, 0.47059, 0.32471],
  ],
  SCOURGE: [[1, 0, 0, 0, -1, 1.0, 0.2, 0.2, 0.2, 1.0, 0, 0, 0]],
  NIGHTELF: [[1, 0, 0, 0, -1, 1.0, 0.0902, 0.0902, 0.1702, 1.0, 0, 0, 0]],
  DRAENEI: [
    [1, 0, 0.61185, 0.62942, -0.47903, 1.0, 0, 0, 0, 1.0, 0.56941, 0.52, 0.6],
    [1, 0, -0.64345, -0.31052, -0.69968, 1.0, 0, 0, 0, 1.0, 0.60941, 0.60392, 0.7],
    [1, 0, -0.46481, -0.1432, 0.87376, 1.0, 0, 0, 0, 2.0, 0.5835, 0.48941, 0.6],
  ],
  BLOODELF: [
    [1, 0, -0.82249, -0.54912, -0.14822, 1.0, 0, 0, 0, 2.0, 0.581175, 0.50588, 0.42588],
    [1, 0, 0, 0, -1, 1.0, 0.60392, 0.6149, 0.7, 1.0, 0, 0, 0],
    [1, 0, 0.02575, 0.86518, -0.50081, 1.0, 0, 0, 0, 1.0, 0.59137, 0.51745, 0.63471],
  ],
  DEATHKNIGHT: [[1, 0, 0, 0, -1, 1.0, 0.38824, 0.66353, 0.76941, 1.0, 0, 0, 0]],
  CHARACTERSELECT: [
    [1, 0, 0, 0, -1, 1.0, 0.15, 0.15, 0.15, 1.0, 0, 0, 0],
    [1, 0, -0.74919, 0.35208, -0.56103, 1.0, 0, 0, 0, 1.0, 0.44706, 0.5451, 0.73725],
    [1, 0, 0.53162, -0.8434, 0.0778, 1.0, 0, 0, 0, 2.0, 0.55, 0.338625, 0.148825],
  ],
};

/** `glueparent.lua:22` -- verbatim. `near` is always 0 in `SetLighting`. */
export const CHAR_MODEL_FOG: Record<string, { r: number; g: number; b: number; far: number }> = {
  HUMAN: { r: 0.8, g: 0.65, b: 0.73, far: 222 },
  ORC: { r: 0.5, g: 0.5, b: 0.5, far: 270 },
  DWARF: { r: 0.85, g: 0.88, b: 1.0, far: 500 },
  NIGHTELF: { r: 0.25, g: 0.22, b: 0.55, far: 611 },
  TAUREN: { r: 1.0, g: 0.61, b: 0.42, far: 153 },
  SCOURGE: { r: 0, g: 0.22, b: 0.22, far: 26 },
  CHARACTERSELECT: { r: 0.8, g: 0.65, b: 0.73, far: 222 },
};

/** `accountlogin.xml:93` authors the login scene's fog on the frame itself, not through the table. */
export const MAIN_MENU_FOG = { r: 0.25, g: 0.06, b: 0.015, near: 0, far: 1200 };

/**
 * The fog triple for a scene key, or null when the client would `ClearFog()`.
 * `params` is the packed `fogParams` vec4 the M2 shader consumes.
 */
export function fogTriple(
  key: string,
): { color: RGB; params: [number, number, number, number] } | null {
  const row = CHAR_MODEL_FOG[key];
  if (!row) {
    return null;
  }
  return { color: [row.r, row.g, row.b], params: packFogParams(0, row.far) };
}

/**
 * Fold a race's light rows into the ambient term plus the SH probe the M2 material's `probeCoeffs`
 * lane expects. Disabled rows (`row[0] === 0`) are skipped, as `SetLighting` skips them.
 */
export function foldRaceLights(rows: RaceLightRow[]): { ambient: RGB; probe: ProbeCoeffs } {
  const ambient: RGB = [0, 0, 0];
  const lobes: Array<{ dir: Vec3; color: RGB }> = [];

  for (const row of rows) {
    if (row[0] === 0) {
      continue;
    }

    const direction: Vec3 = [row[2], row[3], row[4]];
    const ambientIntensity = row[5];
    const diffuseIntensity = row[9];

    ambient[0] += row[6] * ambientIntensity;
    ambient[1] += row[7] * ambientIntensity;
    ambient[2] += row[8] * ambientIntensity;

    const color: RGB = [
      row[10] * diffuseIntensity,
      row[11] * diffuseIntensity,
      row[12] * diffuseIntensity,
    ];

    if (color[0] > 0 || color[1] > 0 || color[2] > 0) {
      lobes.push({ dir: direction, color });
    }
  }

  return { ambient, probe: propProbeCoeffs(ambient, lobes) };
}

/**
 * The authored FOV is the client's DIAGONAL opening angle. Its projection build takes
 * `half = (fov / 2) / sqrt(aspect^2 + 1)`, so the full vertical angle is `fov / sqrt(aspect^2 + 1)`
 * -- 0.6 x fov at 4:3. A wider window therefore narrows vertically and widens horizontally, which
 * is how the reference reveals more of the stage on a widescreen display.
 */
export function verticalFov(diagonalFov: number, aspect: number): number {
  return diagonalFov / Math.sqrt(aspect * aspect + 1);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=scene-rig`
Expected: PASS (11 tests)

- [ ] **Step 6: Commit**

```bash
git add client/src/game/ui/scene/tokens.ts client/src/game/ui/scene/scene-rig.ts client/src/game/ui/scene/__tests__/scene-rig.test.ts
git commit -m "feat(ui): transcribe the glue scene tokens, fog and light rig"
```

---

### Task 13: The glue scene

**Files:**
- Create: `client/src/game/ui/scene/glue-scene.ts`
- Modify: `client/src/game/ui/screens.ts` (own a `GlueSceneView`, render it before the UI pass, expose `setScene`/`yaw` on `GlueContext`)
- Modify: `client/src/game/ui/screens/probe.ts` (show `UI_MainMenu` behind the probe widgets)

**Interfaces:**
- Consumes: `M2Blueprint` from `../../pipeline/m2/blueprint`, `worldClock` from `../../pipeline/m2/anim/world-clock`, `applyPerObjectLighting` from `../../pipeline/m2/material/per-object-light`, `scenePath`/`sceneToken`/`GlueScene` from `./tokens`, `foldRaceLights`/`fogTriple`/`MAIN_MENU_FOG`/`RACE_LIGHTS`/`verticalFov` from `./scene-rig`.
- Produces: `class GlueSceneView { constructor(renderer: THREE.WebGLRenderer); setScene(scene: GlueScene | null): void; set yaw(radians: number); get stageSpot(): THREE.Vector3 | null; update(dt: number): void; render(): void; dispose(): void }`. `GlueContext` gains `setScene(scene: GlueScene | null): void`.

- [ ] **Step 1: Write `glue-scene.ts`**

```ts
/**
 * The 3D glue scene: the model behind every pre-world screen.
 *
 * The mechanism is the client's own, read out of our GlueXML rather than guessed:
 *   `SetBackgroundModel` (glueparent.lua:376) -> Interface\Glues\Models\UI_<token>\UI_<token>.m2
 *   `SetSequence(0)` + `SetCamera(0)` (characterselect.lua:11, charactercreate.lua:66)
 *   `SetLighting` (glueparent.lua:327) -> CharModelFogInfo fog + RaceLights directionals
 * The character (spec 6) stands on the scene's attachment **id 0** -- the stage spot, on camera 0's
 * axis in every UI_* scene.
 *
 * Two notes that decide the code:
 *  - `SetCamera(index)` indexes the camera TABLE directly. These scenes ship one camera whose
 *    `cameraLookups` slot holds the 0xffff none sentinel, so a lookup-based selection finds nothing.
 *  - We render DIRECTLY into the canvas, first pass, with the widget layer over it. benilla bakes
 *    its glue scene to an offscreen target because one booth serves portraits, paper doll and glue
 *    alike; we have no such sharing, and a fullscreen render-to-texture would cost a target and a
 *    blit for nothing.
 */
import * as THREE from 'three';

import { worldClock } from '../../pipeline/m2/anim/world-clock';
import M2Blueprint from '../../pipeline/m2/blueprint';
import {
  applyPerObjectLighting,
  MAX_POINT_LIGHTS,
  SelectedLight,
} from '../../pipeline/m2/material/per-object-light';
import { packFogParams } from '../../world/light/fog';
import {
  foldRaceLights,
  fogTriple,
  MAIN_MENU_FOG,
  RACE_LIGHTS,
  verticalFov,
} from './scene-rig';
import { GlueScene, raceKey, scenePath, sceneToken } from './tokens';

/** The scene's own root, so the character can yaw without the stage yawing with it. */
export class GlueSceneView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  private readonly root = new THREE.Group();

  private requested: GlueScene | null = null;
  private loadedToken: string | null = null;
  private model: any = null;
  private cameraDef: any = null;
  private stage: THREE.Vector3 | null = null;
  private lighting: {
    probe: ReturnType<typeof foldRaceLights>['probe'];
    pointLights: SelectedLight[];
    fogColor: THREE.Color;
    fogParams: [number, number, number, number];
  } | null = null;

  yaw = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.scene.name = 'GlueScene';
    this.scene.add(this.root);
    // WoW model space is Z-up.
    this.camera.up.set(0, 0, 1);
  }

  /** The character's spot, model space. Null until a scene is loaded (spec 6 consumes it). */
  get stageSpot(): THREE.Vector3 | null {
    return this.stage;
  }

  setScene(scene: GlueScene | null): void {
    this.requested = scene;

    if (!scene) {
      this.teardown();
      return;
    }

    const token = sceneToken(scene);
    if (token === this.loadedToken) {
      return;
    }

    this.teardown();
    this.loadedToken = token;

    M2Blueprint.load(scenePath(scene)).then((model) => {
      // A scene swap while this was in flight: drop the late arrival rather than stacking stages.
      if (this.loadedToken !== token) {
        M2Blueprint.unload(model);
        return;
      }

      this.model = model;
      this.root.add(model);

      // `SetSequence(0)` is the FILE SLOT, not an AnimationData id -- slot 0 is the stage's own
      // ambient loop.
      const sequence = model.modelAnim?.sequences?.[0];
      if (sequence && model.instanceAnim) {
        model.instanceAnim.arm(sequence, worldClock.ms);
      }

      this.cameraDef = model.data?.cameras?.[0] ?? null;
      const attachment = (model.data?.attachments ?? []).find((entry: any) => entry.id === 0);
      this.stage = attachment
        ? new THREE.Vector3(attachment.position[0], attachment.position[1], attachment.position[2])
        : new THREE.Vector3();

      this.lighting = this.buildRig(scene, model);
    });
  }

  /**
   * Fold the rig once per scene: RaceLights into the probe lane, the model's own POINT lights into
   * the point table, and the fog triple from `CharModelFogInfo` (or the login screen's authored
   * `ModelFFX` values).
   */
  private buildRig(scene: GlueScene, model: any): NonNullable<GlueSceneView['lighting']> {
    const key = scene.kind === 'mainmenu' ? 'CHARACTERSELECT' : raceKey(scene.race);
    const rows = RACE_LIGHTS[key] ?? RACE_LIGHTS.HUMAN;
    const { probe } = foldRaceLights(rows);

    const pointLights: SelectedLight[] = [];
    for (const light of model.data?.lights ?? []) {
      if (light.type !== 1) {
        continue; // directional: our build takes those from the Lua table, not the model
      }
      if (light.visibility?.firstKeyframe?.value === 0) {
        continue; // a light the asset ships explicitly dark
      }
      const color = light.diffuseColor?.firstKeyframe?.value ?? [1, 1, 1];
      const intensity = light.diffuseIntensity?.firstKeyframe?.value ?? 1;
      pointLights.push({
        position: [light.position[0], light.position[1], light.position[2]],
        color: [color[0] * intensity, color[1] * intensity, color[2] * intensity],
        attenStart: light.attenuationStart?.firstKeyframe?.value ?? 0,
        attenEnd: light.attenuationEnd?.firstKeyframe?.value ?? 0,
      });
      if (pointLights.length >= MAX_POINT_LIGHTS) {
        break;
      }
    }

    if (scene.kind === 'mainmenu') {
      return {
        probe,
        pointLights,
        fogColor: new THREE.Color(MAIN_MENU_FOG.r, MAIN_MENU_FOG.g, MAIN_MENU_FOG.b),
        fogParams: packFogParams(MAIN_MENU_FOG.near, MAIN_MENU_FOG.far),
      };
    }

    const fog = fogTriple(key);
    return {
      probe,
      pointLights,
      fogColor: fog ? new THREE.Color(fog.color[0], fog.color[1], fog.color[2]) : new THREE.Color(0, 0, 0),
      // No row means ClearFog(): push the fog band past the far plane instead of branching in the
      // shader.
      fogParams: fog ? fog.params : packFogParams(0, 100000),
    };
  }

  update(dt: number): void {
    if (!this.model) {
      return;
    }

    const clock = worldClock.ms;

    if (this.model.instanceAnim) {
      this.model.evaluateMaterialChannels(clock);
      this.model.applyPose();
    }
    this.model.updateMatrixWorld(true);

    this.aimCamera();
  }

  /** Camera 0 owns the framing while a scene is up. */
  private aimCamera(): void {
    const def = this.cameraDef;
    if (!def) {
      return;
    }

    const key = def.positions?.firstKeyframe?.value;
    const targetKey = def.targetPositions?.firstKeyframe?.value;
    const base = def.positionBase;
    const targetBase = def.targetBase;

    this.camera.position.set(
      base[0] + (key ? key[0] : 0),
      base[1] + (key ? key[1] : 0),
      base[2] + (key ? key[2] : 0),
    );
    this.camera.lookAt(
      targetBase[0] + (targetKey ? targetKey[0] : 0),
      targetBase[1] + (targetKey ? targetKey[1] : 0),
      targetBase[2] + (targetKey ? targetKey[2] : 0),
    );

    const size = this.renderer.getSize(new THREE.Vector2());
    const aspect = size.x / Math.max(size.y, 1);
    this.camera.aspect = aspect;
    this.camera.fov = THREE.MathUtils.radToDeg(verticalFov(def.fov, aspect));
    this.camera.near = Math.max(def.nearClip, 0.05);
    this.camera.far = def.farClip;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    if (!this.model || !this.lighting) {
      return;
    }

    // The rig is per-scene, but M2 materials are shared across instances, so it has to be pushed
    // for THIS draw -- `applyPerObjectLighting` sets `uniformsNeedUpdate` for exactly that reason.
    this.model.traverse((node: any) => {
      const material = node.material;
      if (!material?.uniforms) {
        return;
      }
      applyPerObjectLighting(material, {
        interior: true, // the probe lane: this stage is lit by its rig, not by the world sun
        interiorFog: false,
        sunIntensity: 1,
        probe: this.lighting!.probe,
        pointLights: this.lighting!.pointLights,
      });
      material.uniforms.fogColor.value.copy(this.lighting!.fogColor);
      material.uniforms.fogParams.value.fromArray(this.lighting!.fogParams);
    });

    this.renderer.render(this.scene, this.camera);
  }

  private teardown(): void {
    if (this.model) {
      this.root.remove(this.model);
      M2Blueprint.unload(this.model);
    }
    this.model = null;
    this.cameraDef = null;
    this.stage = null;
    this.lighting = null;
    this.loadedToken = null;
  }

  dispose(): void {
    this.teardown();
  }
}
```

- [ ] **Step 2: Wire it into `screens.ts`**

Three edits:

```ts
import { GlueSceneView } from './scene/glue-scene';
import { GlueScene } from './scene/tokens';
```

Add to `GlueContext`:

```ts
export interface GlueContext {
  root: WidgetRoot;
  art: GlueArt;
  strings: GlueStrings;
  input: GlueInput;
  /** Show a glue background scene, or null to tear it down. */
  setScene(scene: GlueScene | null): void;
  go(state: ClientState): void;
}
```

In `GlueApp`, own the view, hand it to screens, render it before the UI pass, and drop it on stop:

```ts
  private readonly sceneView: GlueSceneView;
```
```ts
    this.sceneView = new GlueSceneView(this.renderer);
```
In `enter`'s context literal, add `setScene: (scene) => this.sceneView.setScene(scene)`.
In `enter`, before `screen.mount(ctx)`, add `this.sceneView.setScene(null);` — a screen that wants no scene gets none, and a screen that wants one asks on mount.
In `tick`, between `screen.update(dt)` and the draw list:

```ts
    this.renderer.clear();
    this.sceneView.update(dt);
    this.sceneView.render();
```
and remove the later standalone `this.renderer.clear()` so the UI pass draws over the scene.
In `stop`, add `this.sceneView.dispose();`.

- [ ] **Step 3: Show the scene in the probe screen**

In `ProbeScreen#mount`, after registering art:

```ts
    // The login scene, chosen exactly as accountlogin.lua does. `northrend: false` is the base
    // main menu; spec 3 picks the variant from the account's expansion level.
    ctx.setScene({ kind: 'mainmenu', northrend: false });
```

- [ ] **Step 4: Verify tests still pass**

Run: `cd client && npm test -- --watchAll=false --testPathPattern="ui/"`
Expected: PASS — the pure suites are untouched.

- [ ] **Step 5: Verify by hand**

Run: `cd client && npm start`, open `http://localhost:3000/glue`.
Expected, each checked explicitly:
1. The `UI_MainMenu` gate scene draws behind the probe widgets, framed by the model's own camera (not a default view).
2. Sequence 0 loops: the scene's fires and animated geometry move continuously.
3. The scene is fogged warm-dark, consistent with `fogColor 0.25/0.06/0.015`, `fogFar 1200`.
4. Widening the window reveals more of the stage horizontally rather than letterboxing.
5. The widgets from Task 11 still draw and still work on top of it.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/ui/scene/glue-scene.ts client/src/game/ui/screens.ts client/src/game/ui/screens/probe.ts
git commit -m "feat(ui): stand the 3D glue scene up behind the widgets"
```

---

### Task 14: The offline world route

**Files:**
- Create: `client/src/network/offline-session.ts`
- Modify: `client/src/app.tsx` (build the game route's session from the URL)
- Test: `client/src/network/__tests__/offline-session.test.ts`

**Interfaces:**
- Consumes: `GameSession` from `./session`.
- Produces: `isOfflineRequested(search: string): boolean`, `OFFLINE_SPOT_ID`, `createOfflineSession(): GameSession`, `sessionForSearch(search: string): GameSession`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The offline debug route. The point of these tests is the NEGATIVE: no socket may be opened, so
 * world/render debugging never depends on a server being up.
 */
import { isOfflineRequested, OFFLINE_SPOT_ID, sessionForSearch } from '../offline-session';

jest.mock('../../game/world', () => {
  return {
    __esModule: true,
    default: class FakeWorld {
      player = { worldport: jest.fn() };
      scene = { add: jest.fn() };
    },
  };
});

describe('isOfflineRequested', () => {
  it('accepts the flag with and without a value', () => {
    expect(isOfflineRequested('?offline=1')).toBe(true);
    expect(isOfflineRequested('?offline')).toBe(true);
    expect(isOfflineRequested('?account=x&offline=1')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isOfflineRequested('')).toBe(false);
    expect(isOfflineRequested('?account=x')).toBe(false);
    expect(isOfflineRequested('?offline=0')).toBe(false);
  });
});

describe('sessionForSearch', () => {
  it('opens no socket in offline mode', () => {
    const session = sessionForSearch('?offline=1');

    expect((session.game as any).connected).toBeFalsy();
    expect((session.auth as any).connected).toBeFalsy();
    expect((session as any).offline).toBe(true);
  });

  it('seeds a stub character at a known spot', () => {
    const session = sessionForSearch('?offline=1');

    expect((session as any).offlineSpot).toBe(OFFLINE_SPOT_ID);
    expect(session.player).toBeTruthy();
  });

  it('returns a plain session without the flag', () => {
    expect((sessionForSearch('') as any).offline).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=offline-session`
Expected: FAIL — cannot resolve `../offline-session`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The networking-free way into the world.
 *
 * `/game?offline=1` loads the world with a stub character and opens NO socket, so world and render
 * work does not wait on an auth server, a realm, or a character. Neither `AuthHandler` nor
 * `GameHandler` connects in its constructor -- only `connect()` does -- so "offline" is a matter of
 * never calling it, plus saying so out loud.
 *
 * The announcement is not decoration. The reference marks a no-IO run with a dedicated resource for
 * exactly this reason (benilla `net.rs#NetOffline`): a run that cannot exercise the wire must never
 * be mistaken for one that did.
 */
import spots from '../game/world/spots';
import { GameSession } from './session';

/** Where the offline character stands. A named spot, so the debug entry is reproducible. */
export const OFFLINE_SPOT_ID = 'stormwind';

export function isOfflineRequested(search: string): boolean {
  const params = new URLSearchParams(search);
  if (!params.has('offline')) {
    return false;
  }
  const value = params.get('offline');
  return value === null || value === '' || value === '1' || value === 'true';
}

/** A session that will never connect, carrying a stub character and a spawn spot. */
export function createOfflineSession(): GameSession {
  const session = new GameSession() as GameSession & {
    offline: boolean;
    offlineSpot: string;
  };

  session.offline = true;
  session.offlineSpot = OFFLINE_SPOT_ID;

  console.info(
    `[offline] no auth, realm or world socket will be opened; standing at "${OFFLINE_SPOT_ID}"`,
  );

  return session;
}

export function sessionForSearch(search: string): GameSession {
  return isOfflineRequested(search) ? createOfflineSession() : new GameSession();
}

/** The spot record the game screen worldports to on offline entry. */
export function offlineSpot() {
  return spots.find((spot: any) => spot.id === OFFLINE_SPOT_ID) ?? spots[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=offline-session`
Expected: PASS (6 tests)

- [ ] **Step 5: Enter the world on mount when offline**

In `client/src/app.tsx`, replace `const gameSession = new GameSession();` with:

```tsx
  // `?offline=1` builds a session that never connects -- the debug path into the world.
  const gameSession = sessionForSearch(window.location.search);
```

and add the import:

```tsx
import { sessionForSearch } from './network/offline-session';
```

In `client/src/pages/game/index.tsx`, at the end of `componentDidMount` (after the renderer and world are set up), worldport when the session is offline:

```tsx
    // Offline debug entry: nothing will ever send us a login-verify, so place the character now.
    if ((this.props.session as any).offline) {
      const spot = offlineSpot();
      this.game.world.player.worldport(spot.zoneId, spot.coords);
      this.setState({ currentLocation: spot.id });
    }
```

with the import:

```tsx
import { offlineSpot } from '../../network/offline-session';
```

- [ ] **Step 6: Verify by hand**

Run: `cd client && npm start`, open `http://localhost:3000/game?offline=1` with the Network tab open.
Expected:
1. The world loads and the character stands in Stormwind.
2. The console carries the `[offline]` notice once.
3. **No WebSocket connection appears in the Network tab.**

- [ ] **Step 7: Commit**

```bash
git add client/src/network/offline-session.ts client/src/network/__tests__/offline-session.test.ts client/src/app.tsx client/src/pages/game/index.tsx
git commit -m "feat(net): add the networking-free /game?offline=1 debug route"
```

---

## Done criteria

- `cd client && npm test -- --watchAll=false` passes, including the five new suites (camera, light/attachment, layout, hit, strings, scene-rig, offline-session).
- `/glue` draws the `UI_MainMenu` scene with real client art, working button/edit box/dialog on top, correct scaling from a short window to a tall one.
- `/game?offline=1` reaches the world with no socket.
- `/`, `/realms`, `/characters` still work exactly as before.

---

## Follow-ups carried out of this plan

Everything below was raised by a review, judged not to block this work, and left for whoever
builds on the foundation. Recorded here because the review workspace is scratch and git is not.

**Verified in a real browser**, with Playwright driving the installed Chrome against the dev server
(the probe scripts were scratch and are not committed). The probe screen at `/glue` draws real client
art over the live `UI_MainMenu` scene: the button swaps hover and pressed art, releasing ON it opens
the dialog while a press dragged OFF it does not, clicking the dialog dismisses it, the edit box
takes typing capped at its authored 16 letters, a Shift+Home selection is replaced by the next
keystroke, and Tab then Enter reaches the button. The scene renders through the model's authored
camera with the `accountlogin.xml` fog — 21 draw calls, 8212 triangles. The scale law holds at window
heights 911, 768 and 640 and at 2200x720: everything scales, nothing clips, a wider window reveals
more stage. `/game?offline=1` reaches Stormwind at 60 FPS, logs its `[offline]` notice exactly once,
raises zero page errors, and the only websocket on the page is the dev server's own HMR channel.

Three real bugs surfaced only under a browser, all now fixed: UI quads were culled as back faces (the
Y-down projection mirrors winding, and three.js compensates for an object's matrix but never for the
camera's projection), the scene model stayed hidden (`M2` constructs itself invisible and in the
world it is the visibility manager that shows each placement), and every font string was stretched to
its widget rect because the measured size was returned flat while the renderer reads it nested. Each
now has a test or a type that makes silent reintroduction impossible.

**Known wrong, and measured: the scene's composition.** The mechanism is right — model, authored
camera 0, sequence 0, fog, lights and pose all reach the driver — but neither main-menu scene frames
correctly. `UI_MainMenu` fills about a fifth of the frame (banner poles, grass and a pedestal lit by
the model's own point lights) with the rest empty; `UI_MainMenu_Northrend` fills 100% of it with a
single flat cyan surface, i.e. the camera sits inside a mesh. Measurements that narrow it down, so
spec 3 does not start from scratch: all 24 drawable meshes are present and visible, including three
large dome meshes (radii 570/400/232, flagged unlit — the cloud layers) and terrain at radius 582;
raising the ambient to flat white lifted mean luma 16.9 → 25.8 while leaving the non-black share at
20.5%, which means the empty areas are geometry the camera does not see rather than geometry lit to
black. So the remaining suspects are the camera record's interpretation (eye and target both land
within a few units of the origin) and whether a glue scene needs a transform we are not applying —
not lighting, and not missing geometry.

**Still unverified.** Fidelity against the real client's login screen: the probe proves the mechanism,
not the composition, and only the transcribed `AccountLogin` of spec 3 can be compared side by side.
Separately, `Fonts\SKURRI.TTF` is rejected by Chrome's font sanitiser ("bad table directory",
"Invalid font data in ArrayBuffer"). The file is served intact, so its table directory does not meet
what Chrome enforces; FRIZQT and MORPHEUS load, and no glue screen asks for SKURRI yet, so this is
logged rather than worked around.

**Spec gaps left open, for spec 3 to close.** Text has no `maxWidth` and no wrapping — nothing in the
glue screens needed it, and spec 7's race/class description paragraphs will (they also need the Lua
`..` multi-line concatenation `strings.ts` currently skips, the same limitation benilla documents).
`GlueContext.session` is wired but nothing reads it yet; the login screen is its first consumer.

**Sub-pixel and allocation debts.** `measureText` uses the raw glyph width where the rasterizer ceils
it, and `cssFont` rounds where the height math ceils — under one device pixel each, worth revisiting
only if text looks soft. `renderer.ts` allocates a `THREE.Vector2` per frame for `getSize`;
`tick()` allocates a viewport object and a resolver closure per frame, and `drawList` rebuilds its
arrays every frame though the tree is retained — add a dirty flag when a real screen's widget count
makes it measurable.

**Latent, currently unreachable.** `appendBLP` treats a dot ANYWHERE in a path as an extension, so a
future GlueXML path with a dotted directory would 404 — scope the test to the last segment when the
real screen tables land. A caller-supplied duplicate widget id would collide in the anchor map and
silently take the wrong rect. A rejected texture fetch leaks its `TextureLoader` reference count
(that contract predates this branch). The glue frame loop and `World#animate` both advance
`worldClock`, which is safe only because they never run at once — whoever wires the `InWorld`
transition must keep it that way. Masking and selection index UTF-16 code units, not graphemes.
