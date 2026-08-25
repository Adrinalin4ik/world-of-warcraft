/**
 * THE WORLD CURSOR'S DRIVER: a resolved mode -> a real CSS cursor cut from the game's own BLP art.
 *
 * ## Why CSS and not a quad
 *
 * This client already draws one thing at the pointer -- the dragged ability icon
 * (`world-ui.ts#drawCursorIcon`) -- and extending that to the POINTER ITSELF is a different
 * proposition, because it obliges `cursor: none` on the whole page. Every failure mode of a drawn
 * pointer (the BLP not landing, the quad pass not running, an exception before the draw, a resize
 * race) then leaves the user with **no pointer at all** and no way to reach a menu to fix it. A CSS
 * cursor degrades the other way: if the data URI is missing the browser keeps the previous cursor,
 * and the declared fallback keeps a real arrow. The real client does set `cursor: none` and draw its
 * own -- that is a fidelity cost, stated: our pointer is composited by the OS rather than by the
 * frame, so it does not lag the world by a frame, and it is not clipped to the canvas.
 *
 * It also costs **nothing per frame**: `document.body.style.cursor` is written only when the stem
 * changes, so a pointer sitting over the same wolf for ten seconds does no work at all.
 *
 * ## The hotspot is NOT sourced, and this file says so where it matters
 *
 * 32x32 art says nothing about which texel is the point, and round 22 recorded that as the first
 * open question on this feature. `HOTSPOT` is therefore `0,0` -- the CSS default and the top-left
 * texel. `cursorArtReport()` exists so the question can be MEASURED rather than argued: it reports
 * each decoded stem's opaque bounding box, which is what tells you whether the arrow's tip is at the
 * corner or whether the art is padded.
 */
import * as THREE from 'three';

import TextureLoader from '../pipeline/texture-loader';
import { PRIORITY } from '../pipeline/worker/pool';
import { CURSOR_POINT, WorldCursorMode, cursorStem } from '../world/cursor-mode';

/**
 * The asset host is **lowercase-only** (`STATE.md`: `Interface/FrameXML/Bindings.xml` 404s while the
 * lowercase spelling is 200). `TextureLoader` upper-cases for its cache key and the manifest layer
 * lowercases for the fetch, so this path goes through the normal loader for exactly that reason
 * rather than a hand-written `fetch` of the pretty-cased name.
 */
const CURSOR_DIR = 'interface/cursor/';

/**
 * The CSS hotspot, in texels from the art's top-left. **UNSOURCED** -- see this file's header. It is
 * cosmetic only: hit testing everywhere in this client is done on `clientX`/`clientY`, which the
 * hotspot does not move, so a wrong value misaligns the drawing and nothing else.
 */
const HOTSPOT_X = 0;
const HOTSPOT_Y = 0;

/**
 * WARMED AT CONSTRUCTION, and the reason is a defect this round's own probe caught.
 *
 * `apply` cannot write a stem whose BLP has not landed -- it leaves the cursor alone rather than
 * flashing the browser arrow. Loaded lazily on first hover that turned into a real hole: the first
 * pass of the gate reported `stem: "Attack"` while the PNG the browser had actually been handed was
 * still `Point`, byte-identical across all seven arms. The stem was right and the pixels were the
 * previous cursor's, because `attack.blp` was queued behind the 49 MB DBC stream and had not arrived
 * inside the 120 ms the arm waited. A user would see the same thing as "the cursor does not change on
 * the first wolf and works after that", which is worse than either state.
 *
 * So every stem the CLASSIFIER can produce is fetched up front -- 17 files, ~3 KB of texels each,
 * once per world entry. `Skin`'s twin is included even though the skin leg is currently unreachable
 * (see `cursor-mode.ts#classifyUnitCursor`), because the list's job is to match the classifier's
 * range exactly and a list that drifts from it reintroduces the hole silently.
 *
 * `Point` has no `Unable` twin on the asset host, which is why it appears once.
 */
const WARM_STEMS = [
  'Point',
  'Attack', 'UnableAttack',
  'Speak', 'UnableSpeak',
  'Pickup', 'UnablePickup',
  'LootAll', 'UnableLootAll',
  'Interact', 'UnableInteract',
  'Buy', 'UnableBuy',
  'Trainer', 'UnableTrainer',
  'Taxi', 'UnableTaxi',
  'Skin', 'UnableSkin',
];

/** One decoded stem: the data URI the style is set to, and what the art turned out to be. */
interface CursorArt {
  stem: string;
  css: string;
  width: number;
  height: number;
  /** The opaque bounding box `[x0, y0, x1, y1]` in texels, or null when nothing is opaque. */
  opaqueBox: [number, number, number, number] | null;
}

export class WorldCursorDriver {
  private readonly art = new Map<string, CursorArt>();

  /** Stems already asked for, so a miss is not re-fetched every 100 ms. */
  private readonly requested = new Set<string>();

  /** The stem currently written to the element, so nothing is written twice. */
  private applied: string | null = null;

  private readonly element: HTMLElement;

  /** What the element's inline cursor was before this driver touched it. */
  private readonly savedCursor: string;

  constructor(element: HTMLElement) {
    this.element = element;
    this.savedCursor = element.style.cursor;
    WARM_STEMS.forEach((stem) => this.ensure(stem));
  }

  /**
   * Show `mode`. Cheap and idempotent -- a repeated call with the same mode does nothing at all.
   *
   * A stem whose BLP has not landed yet leaves the cursor where it is rather than falling back to the
   * browser arrow, so a slow decode is a stale cursor for a frame or two and never a flicker.
   */
  apply(mode: WorldCursorMode): void {
    const stem = cursorStem(mode);
    const art = this.ensure(stem);
    if (art === null || this.applied === stem) {
      return;
    }
    this.applied = stem;
    // `, default` is the mandatory CSS fallback: a UA that rejects the image (or a data URI over the
    // 128x128 limit some browsers impose) still gets a pointer.
    this.element.style.cursor = `url(${art.css}) ${HOTSPOT_X} ${HOTSPOT_Y}, default`;
  }

/**
   * Write the current cursor to the element AGAIN, even though nothing about it changed.
   *
   * `apply` early-outs on an unchanged stem, which is right for the per-frame hover path and wrong for
   * one case: **the browser has just stopped showing our cursor for a reason of its own.** Exiting a
   * pointer lock is that case -- the style is still on the element, but a custom `url(...)` cursor is
   * repainted only when the pointer moves, so the arrow stays absent until the player happens to move
   * the mouse. That is the tail of the owner's report: "появляется только когда начинается движение."
   *
   * Rewriting the property forces the re-evaluation. One style write per pointer-lock exit, which is
   * once per genuine mouse-look drag, so this is not on any per-frame path.
   */
  refresh(): void {
    if (this.applied === null) {
      return;
    }
    const art = this.ensure(this.applied);
    if (art === null) {
      return;
    }
    this.element.style.cursor = `url(${art.css}) ${HOTSPOT_X} ${HOTSPOT_Y}, default`;
  }

  /** Back to the resting arrow -- the game's own `Point`, not the browser's. */
  reset(): void {
    this.apply(CURSOR_POINT);
  }

  /**
   * Give the element its own cursor back WITHOUT tearing the driver down, so a later `apply` still works.
   *
   * This is `window.worldCursorEnabled = false`'s arm. Idempotent: the write happens only when something
   * of ours is currently on the element, so the off arm is not a style write per frame.
   */
  revert(): void {
    if (this.applied === null) {
      return;
    }
    this.applied = null;
    this.element.style.cursor = this.savedCursor;
  }

  /** Give the element its own cursor back. Called from the world screen's unmount. */
  dispose(): void {
    this.element.style.cursor = this.savedCursor;
    this.applied = null;
  }

  /**
   * THE INSTRUMENT, and it is what the hotspot question rests on: for every stem decoded so far, the
   * art's size and the bounding box of its opaque texels. An arrow whose tip is the top-left texel
   * has `opaqueBox[0] === 0 && opaqueBox[1] === 0`; padded art does not.
   *
   * `window.worldCursorArt` (registered by `pages/game/index.tsx`).
   */
  cursorArtReport(): unknown {
    return {
      applied: this.applied,
      hotspot: [HOTSPOT_X, HOTSPOT_Y],
      stems: [...this.art.values()].map(({ stem, width, height, opaqueBox }) => ({
        stem, width, height, opaqueBox,
      })),
      missing: [...this.requested].filter((stem) => !this.art.has(stem)),
    };
  }

  /** The decoded art for a stem, kicking off its load on first ask. Null while it is not ready. */
  private ensure(stem: string): CursorArt | null {
    const ready = this.art.get(stem);
    if (ready) {
      return ready;
    }
    if (this.requested.has(stem)) {
      return null;
    }
    this.requested.add(stem);
    // CLAMPED wrapping, which is also what makes the cache key distinct from any world use of the
    // same path. The reference is never released: there are at most ~40 of these, each 4 KB of
    // texels, and they are wanted for the whole session -- releasing and re-fetching on every hover
    // would be the opposite of the point.
    TextureLoader.load(
      `${CURSOR_DIR}${stem.toLowerCase()}.blp`,
      // `as any` because `texture-loader.js` is untyped JS whose default parameter narrows the
      // inferred type to `RepeatWrapping` alone -- the same cast `game/ui/art.ts:103-107` makes for
      // the same reason.
      THREE.ClampToEdgeWrapping as any,
      THREE.ClampToEdgeWrapping as any,
      // CHARACTER, not the default BACKGROUND: 3 KB behind the terrain and DBC stream is what made the
      // lazy version show the wrong pixels for its first hover. `pool.js#PRIORITY` has exactly two
      // rungs and this is the "something visible is missing NOW" one.
      PRIORITY.CHARACTER,
    )
      .then((texture: THREE.Texture) => {
        const decoded = encodeCursor(stem, texture);
        if (decoded !== null) {
          this.art.set(stem, decoded);
        }
      })
      .catch(() => {
        // A 404 is an ORDINARY outcome here: round 22 measured six plausible-looking stems that are
        // not served at all. The stem stays in `requested`, so it is asked for once and then left
        // alone, and `cursorArtReport().missing` names it.
      });
    return null;
  }
}

/**
 * A decoded BLP -> a PNG data URI.
 *
 * The BLP pipeline hands palettized art back as `IMAGE_ABGR8888`, which `wow-data-parser/blp/pal.ts`
 * actually emits in **R,G,B,A byte order** (its three writes are `palette[+2], [+1], [+0]` over a
 * little-endian RGB palette, then alpha) -- i.e. exactly `ImageData`'s layout, so the rows go
 * straight into a 2D canvas with no swizzle. Row order is the file's own, top row first, because
 * nothing in `pal.ts` reverses it.
 *
 * Returns null for a compressed texture: round 22 header-decoded every stem in `interface/cursor/`
 * and **all of them are palettized**, so a DXT one here would mean the art is not what was measured
 * and guessing at it is worse than showing no cursor.
 */
function encodeCursor(stem: string, texture: THREE.Texture): CursorArt | null {
  const image = (texture as THREE.DataTexture).image as
    | { data?: ArrayBufferView; width: number; height: number }
    | undefined;
  const raw = image?.data;
  if (!image || !raw || !(raw instanceof Uint8Array)) {
    return null;
  }
  const { width, height } = image;
  if (raw.length < width * height * 4) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  // A copy, not a view onto the texture's own buffer: `ImageData` takes ownership of its array and
  // the texture's is still the one the GPU upload reads.
  const pixels = new ImageData(new Uint8ClampedArray(raw.subarray(0, width * height * 4)), width, height);
  context.putImageData(pixels, 0, 0);

  return {
    stem,
    css: canvas.toDataURL('image/png'),
    width,
    height,
    opaqueBox: opaqueBoxOf(raw, width, height),
  };
}

/** The bounding box of texels with any alpha at all. See `cursorArtReport`. */
function opaqueBoxOf(
  rgba: Uint8Array,
  width: number,
  height: number,
): [number, number, number, number] | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      if (rgba[(y * width + x) * 4 + 3] !== 0) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}
