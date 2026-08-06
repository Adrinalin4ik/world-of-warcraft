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
import { ResolvedSprite } from './renderer';
import { FontSpec } from './widget';

/** The client's shipped faces, by the family name widgets ask for. */
const FONT_FILES: Record<string, string> = {
  FRIZQT: 'Fonts\\FRIZQT__.TTF',
  MORPHEUS: 'Fonts\\MORPHEUS.TTF',
  SKURRI: 'Fonts\\SKURRI.TTF',
  ARIALN: 'Fonts\\ARIALN.TTF',
};

/**
 * Padding around rasterized text.
 * HORIZONTAL: clearance for stroke width (lineWidth=2, so 1px on each side) plus room for subpixel positioning.
 * VERTICAL: clearance for stroke width plus extra for centered textBaseline.
 */
const PADDING_H = 4;
const PADDING_V = 6;

/** Maximum entries in the rasterized-text cache before LRU eviction. */
const TEXTURE_CACHE_MAX = 256;

/**
 * The reverse of `FONT_FILES`: what `FontString:SetFont(fontFile, height, flags)` passes is the file
 * PATH the client ships, not the family name widgets otherwise ask for by name (`FontSpec.family`,
 * `SetFontObject`'s eventual target). Matched case-insensitively and slash-insensitively, since
 * FrameXML spells the same path both ways across files. Null when the path names a face we did not
 * bundle -- `SetFont` no-ops on that face rather than guessing one.
 */
export function familyForFontFile(fontFile: string): string | null {
  const needle = fontFile.replace(/\//g, '\\').toLowerCase();
  for (const [family, path] of Object.entries(FONT_FILES)) {
    if (path.toLowerCase() === needle) {
      return family;
    }
  }
  return null;
}

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
        document.fonts.add(face);
      } catch (error) {
        console.warn(`glue font ${family} unavailable:`, error);
      }
    }),
  ).then(() => undefined);

  return fontsPromise;
}

/**
 * The WebGL backing store rasterizes at `devicePixelRatio` (`screens.ts` calls
 * `renderer.setPixelRatio`), but the layout `scale` passed in here is purely the layout law
 * (`screenScale`) and knows nothing about display density. Rasterizing fonts at `scale` alone bakes
 * a 1x-density texture that the GPU then upscales onto a denser backing store -- soft text on any
 * HiDPI display. `density` is the actual pixel scale to rasterize at; logical (layout-unit) sizes
 * still divide by the plain `scale`, so quad placement on screen is unaffected by display density,
 * only sharpness is.
 */
function devicePixelDensity(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

function density(scale: number): number {
  return scale * devicePixelDensity();
}

function cssFont(spec: FontSpec, pixelScale: number): string {
  return `${Math.round(spec.size * pixelScale)}px "${spec.family}"`;
}

let measureContext: CanvasRenderingContext2D | null = null;

function sharedMeasureContext(): CanvasRenderingContext2D {
  if (!measureContext) {
    measureContext = document.createElement('canvas').getContext('2d')!;
  }
  return measureContext;
}

/**
 * The same context, or null where there is no 2D canvas at all -- a headless jsdom without the
 * `canvas` package.
 *
 * The measuring functions below take this path so that a SCREEN can be mounted and updated headlessly
 * (`screens/__tests__/login.test.ts` does exactly that) without a null-context TypeError. They report
 * an honestly degenerate answer in that case -- no wrapping, no caret advance -- rather than inventing
 * per-character widths that would silently disagree with what the browser rasterizes. `get()` does not
 * take this path: rasterizing genuinely requires a canvas, and it already returns through one.
 */
function optionalMeasureContext(): CanvasRenderingContext2D | null {
  try {
    return sharedMeasureContext() ?? null;
  } catch {
    return null;
  }
}

/**
 * Break `text` into the lines it rasterizes as.
 *
 * One line unless `spec.wrapWidth` is set. Wrapping breaks on SPACES, as the client's own does: a
 * word longer than the width is left overlong on its own line rather than split mid-word, because
 * hyphenating an account name or a URL (`RESPONSE_FAILED_TO_CONNECT` contains one) would be worse
 * than overflowing. Explicit newlines in the string are honoured first -- `gluestrings.lua` escapes
 * some -- so a `\n` always starts a line whatever the width.
 */
export function wrapLines(text: string, spec: FontSpec, scale: number): string[] {
  const paragraphs = text.split('\n');
  if (!spec.wrapWidth || spec.wrapWidth <= 0) {
    return paragraphs.length > 1 ? paragraphs : [text];
  }

  const pixelScale = density(scale);
  const context = optionalMeasureContext();
  if (!context) {
    return paragraphs;
  }
  context.font = cssFont(spec, pixelScale);
  // The wrap width is a logical-unit budget; measurement happens in device pixels.
  const budget = spec.wrapWidth * pixelScale;

  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > budget) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }

  return lines;
}

/** Leading from one line's baseline to the next, in logical units. `spacing` is a `Font` attribute. */
function lineHeight(spec: FontSpec): number {
  return spec.size + (spec.spacing ?? 0);
}

/** Logical-unit size of a rendered string, including padding. Same units `get()`'s `size` reports. */
export function measureText(
  text: string,
  spec: FontSpec,
  scale: number,
): { width: number; height: number } {
  const pixelScale = density(scale);
  const context = optionalMeasureContext();
  const lines = wrapLines(text, spec, scale);
  if (!context) {
    return { width: 0, height: spec.size + PADDING_V / scale };
  }
  context.font = cssFont(spec, pixelScale);
  const widest = Math.max(...lines.map((line) => context.measureText(line).width));
  // Padding is rasterized at `pixelScale` (device pixels) below, so it has to come back out at the
  // same rate it went in -- `PADDING_H` scaled by the density's DPR factor, then the whole width
  // divided by `pixelScale`, not `scale`, to land back in logical units.
  return {
    width: (widest + PADDING_H * (pixelScale / scale)) / pixelScale,
    height:
      lines.length > 1
        ? lines.length * spec.size + (lines.length - 1) * (spec.spacing ?? 0) + PADDING_V / scale
        : spec.size + PADDING_V / scale,
  };
}

/**
 * How far the caret sits from the LEFT EDGE OF THE QUAD a font string draws on, in logical units,
 * with `caret` characters before it.
 *
 * OURS: the client's edit-box caret is drawn by the engine and has no XML to transcribe. What is not
 * ours is where it has to land -- that is dictated by how `get()` below rasterizes, so this measures
 * the same prefix through the same context rather than assuming a per-character width. The leading
 * `inset` is the same half-padding `get()` starts its `fillText` at, so offset 0 is the left edge of
 * the first glyph's cell.
 *
 * Pass the MASKED string for a password box: measuring the real one would leak the password's
 * character widths through the caret's position on screen.
 */
export function caretOffset(
  text: string,
  spec: FontSpec,
  scale: number,
  caret: number,
): number {
  const pixelScale = density(scale);
  const context = optionalMeasureContext();
  if (!context) {
    return 0;
  }
  context.font = cssFont(spec, pixelScale);
  const inset = (PADDING_H * devicePixelDensity()) / 2;
  const prefix = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  return (inset + context.measureText(prefix).width) / pixelScale;
}

/** A rasterized string: the texture plus the logical (layout-unit) size the renderer draws it at. */
type Entry = ResolvedSprite & { texture: THREE.CanvasTexture };

export class FontStringTextures {
  private readonly cache = new Map<string, Entry>();

  /**
   * The texture for one string plus its logical (layout-unit) size -- a font string draws at THIS
   * size, positioned in its widget's rect by `FontSpec.align`, never stretched to the rect
   * (`renderer.ts`). Null for empty text -- the renderer skips a widget with no texture, which is
   * exactly right for an empty label.
   */
  get(text: string, spec: FontSpec, scale: number): ResolvedSprite | null {
    if (!text) {
      return null;
    }

    const pixelScale = density(scale);

    const key = [
      text,
      spec.family,
      spec.size,
      spec.color,
      spec.outline ? 'o' : '-',
      spec.align,
      // Wrapping changes the raster, so it has to key it: the same string at two widths is two
      // different textures, and without this the first width served the second.
      spec.wrapWidth ?? 0,
      spec.spacing ?? 0,
      // The cache key must carry the RASTER density, not just the layout scale -- a display change
      // (a window dragged between monitors of different `devicePixelRatio`) must not serve a stale
      // raster baked for the old density.
      Math.round(pixelScale * 100),
    ].join('|');

    const cached = this.cache.get(key);
    if (cached) {
      // LRU: move to end on cache hit
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const dpr = devicePixelDensity();
    const font = cssFont(spec, pixelScale);
    const context = sharedMeasureContext();
    context.font = font;
    const paddingH = PADDING_H * dpr;
    const paddingV = PADDING_V * dpr;
    const inset = paddingH / 2;

    const lines = wrapLines(text, spec, scale);
    const widest = Math.max(...lines.map((line) => context.measureText(line).width));
    const width = Math.ceil(widest) + paddingH;
    // A single line keeps EXACTLY the height it always had, so no existing caption's quad moves;
    // only a wrapped string takes the multi-line path.
    const height =
      lines.length > 1
        ? Math.ceil(lineHeight(spec) * (lines.length - 1) * pixelScale + spec.size * pixelScale) +
          paddingV
        : Math.ceil(spec.size * pixelScale) + paddingV;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(width, 1);
    canvas.height = Math.max(height, 1);

    const target = canvas.getContext('2d')!;
    target.font = font;
    target.textBaseline = 'middle';
    target.textAlign = 'left';

    // Each line's own baseline, and its own x for the string's justification -- a wrapped block is
    // justified line by line (`GlueDialogText` is centred), not as one ragged box.
    const step = lineHeight(spec) * pixelScale;
    const glyphHeight = spec.size * pixelScale;
    lines.forEach((line, row) => {
      const y =
        lines.length > 1 ? paddingV / 2 + row * step + glyphHeight / 2 : canvas.height / 2;
      const lineWidth = context.measureText(line).width;
      const x =
        spec.align === 'CENTER'
          ? inset + (widest - lineWidth) / 2
          : spec.align === 'RIGHT'
            ? inset + (widest - lineWidth)
            : inset;

      if (spec.outline) {
        // The client's baked ring: one device pixel, drawn as a real stroke -- scaled by `dpr` along
        // with everything else rasterized here so it stays one DEVICE pixel, not one (now smaller
        // relative) raster pixel.
        target.lineWidth = 2 * dpr;
        target.lineJoin = 'round';
        target.strokeStyle = '#000000';
        target.strokeText(line, x, y);
      }

      target.fillStyle = spec.color;
      target.fillText(line, x, y);
    });

    const texture = new THREE.CanvasTexture(canvas);
    // Match the BLP convention so `applyTexCoords` needs no special case: row 0 is v = 0.
    texture.flipY = false;
    texture.needsUpdate = true;

    const entry: Entry = {
      texture,
      // Nested under `size` deliberately: this is the exact shape `GlueRenderer` consumes
      // (`ResolvedSprite`), so a font string that forgets to carry its measured size is a TYPE
      // ERROR rather than a silent stretch-to-rect. It shipped flat once, and because `size` is
      // optional and excess properties are not checked on a returned value, every string on screen
      // was quietly stretched to its widget rect until a screenshot caught it.
      size: {
        // Logical units: the raster is denser (`pixelScale` includes `dpr`) but the quad it draws
        // onto must stay the same on-screen size regardless of display density.
        width: canvas.width / pixelScale,
        height: canvas.height / pixelScale,
      },
    };
    this.cache.set(key, entry);

    // LRU eviction: if cache exceeds max size, evict oldest (first) entry
    if (this.cache.size > TEXTURE_CACHE_MAX) {
      const firstKey = this.cache.keys().next().value;
      const evicted = this.cache.get(firstKey);
      if (evicted) {
        evicted.texture.dispose();
      }
      this.cache.delete(firstKey);
    }

    return entry;
  }

  dispose(): void {
    this.cache.forEach((entry) => entry.texture.dispose());
    this.cache.clear();
  }
}
