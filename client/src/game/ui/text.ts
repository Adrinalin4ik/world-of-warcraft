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

/** Logical-unit size of a rendered string, including padding. Same units `get()`'s `size` reports. */
export function measureText(
  text: string,
  spec: FontSpec,
  scale: number,
): { width: number; height: number } {
  const pixelScale = density(scale);
  const context = sharedMeasureContext();
  context.font = cssFont(spec, pixelScale);
  const metrics = context.measureText(text);
  // Padding is rasterized at `pixelScale` (device pixels) below, so it has to come back out at the
  // same rate it went in -- `PADDING_H` scaled by the density's DPR factor, then the whole width
  // divided by `pixelScale`, not `scale`, to land back in logical units.
  return {
    width: (metrics.width + PADDING_H * (pixelScale / scale)) / pixelScale,
    height: spec.size + PADDING_V / scale,
  };
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
    const width = Math.ceil(context.measureText(text).width) + paddingH;
    const height = Math.ceil(spec.size * pixelScale) + paddingV;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(width, 1);
    canvas.height = Math.max(height, 1);

    const target = canvas.getContext('2d')!;
    target.font = font;
    target.textBaseline = 'middle';
    target.textAlign = 'left';

    if (spec.outline) {
      // The client's baked ring: one device pixel, drawn as a real stroke -- scaled by `dpr` along
      // with everything else rasterized here so it stays one DEVICE pixel, not one (now smaller
      // relative) raster pixel.
      target.lineWidth = 2 * dpr;
      target.lineJoin = 'round';
      target.strokeStyle = '#000000';
      target.strokeText(text, inset, canvas.height / 2);
    }

    target.fillStyle = spec.color;
    target.fillText(text, inset, canvas.height / 2);

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
