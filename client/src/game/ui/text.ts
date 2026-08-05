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

/** Logical-unit size of a rendered string, including padding. */
export function measureText(
  text: string,
  spec: FontSpec,
  scale: number,
): { width: number; height: number } {
  const context = sharedMeasureContext();
  context.font = cssFont(spec, scale);
  const metrics = context.measureText(text);
  return {
    width: (metrics.width + PADDING_H) / scale,
    height: spec.size + PADDING_V / scale,
  };
}

type Entry = { texture: THREE.CanvasTexture };

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
      // LRU: move to end on cache hit
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.texture;
    }

    const font = cssFont(spec, scale);
    const context = sharedMeasureContext();
    context.font = font;
    const width = Math.ceil(context.measureText(text).width) + PADDING_H;
    const height = Math.ceil(spec.size * scale) + PADDING_V;

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

    const entry: Entry = { texture };
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

    return texture;
  }

  dispose(): void {
    this.cache.forEach((entry) => entry.texture.dispose());
    this.cache.clear();
  }
}
