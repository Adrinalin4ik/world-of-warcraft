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
 * Padding around rasterized text, in DEVICE pixels at dpr 1.
 *
 * HORIZONTAL: clearance for the outline stroke (lineWidth 2, so 1px each side).
 * VERTICAL: the same, plus room for the centred `textBaseline`'s ascender/descender.
 *
 * IT IS RASTER BLEED AND NOTHING ELSE. It used to be reported as part of the string's SIZE, which
 * put it into the widget's layout rect -- see `measureText`. That was the bug behind "the checkbox
 * sits oddly against its label" and it got WORSE THE SMALLER THE WINDOW, because the padding is a
 * fixed count of device pixels and the rect is in logical units: `PADDING_V / scale` is 5.1 units at
 * 1382x911 (scale 1.186) and **8.4 units at 630x551** (scale 0.717), against a `<FontHeight>` of 10.
 * An 84% overshoot on the height of every auto-sized label, varying with the window.
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
  // `wordWrap === false` is `SetWordWrap(false)`: one line however narrow the rect. Nothing in the
  // manifest authors it (see `FontSpec.wordWrap`), so this is an override with no current exerciser.
  if (!spec.wrapWidth || spec.wrapWidth <= 0 || spec.wordWrap === false) {
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

  // `maxLines` -- the authored hard cap (`spellbookframe.xml:100`, `maxLines="3"`). The overflow is
  // DROPPED, not ellipsised: the real client has no ellipsis here and inventing one would be a
  // different behaviour presented as a fix. Absent means no cap, which is every other string.
  if (spec.maxLines !== undefined && spec.maxLines > 0 && lines.length > spec.maxLines) {
    return lines.slice(0, spec.maxLines);
  }
  return lines;
}

/** Leading from one line's baseline to the next, in logical units. `spacing` is a `Font` attribute. */
function lineHeight(spec: FontSpec): number {
  return spec.size + (spec.spacing ?? 0);
}

/**
 * Logical-unit size of the GLYPHS of a rendered string -- the box the engine calls the font string's
 * rect, and the box everything anchored to that string is anchored to.
 *
 * **NO PADDING.** This used to add `PADDING_H`/`PADDING_V` and it was wrong twice over. It is the
 * function that fills in an unsized `<FontString>`'s width and height (`widget.ts#deriveSize`), so a
 * padded answer inflated the LAYOUT rect with the rasterizer's stroke clearance -- and the client's
 * own documents anchor to those edges. `accountlogin.xml:551-556` is the case that found it:
 * `<CheckButton name="AccountLoginSaveAccountName">` anchors its RIGHT to
 * `AccountLoginSaveAccountNameText`'s LEFT at offset (0,0), i.e. edge to edge, so a rect 4 device px
 * too wide left a visible gap between the box and its label. The vertical error was much larger --
 * see `PADDING_V` -- and both grew as the window shrank, which is why a 630x551 window looks
 * "misaligned" while 1382x911 looks nearly right.
 *
 * The padding still exists in the RASTER: `FontStringTextures#get` reports it separately as `pad`,
 * and `renderer.ts` inflates the quad about the glyph box's centre so no stroke is clipped.
 */
export function measureText(
  text: string,
  spec: FontSpec,
  scale: number,
): { width: number; height: number } {
  const pixelScale = density(scale);
  const context = optionalMeasureContext();
  const lines = wrapLines(text, spec, scale);
  const blockHeight =
    lines.length > 1
      ? lines.length * spec.size + (lines.length - 1) * (spec.spacing ?? 0)
      : spec.size;
  if (!context) {
    return { width: 0, height: blockHeight };
  }
  context.font = cssFont(spec, pixelScale);
  const widest = Math.max(...lines.map((line) => context.measureText(line).width));
  // `pixelScale`, not `scale`: the measurement was taken at the device-pixel font size.
  return { width: widest / pixelScale, height: blockHeight };
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
  // NO INSET. It used to add half the horizontal padding, because the quad's left edge was the padded
  // canvas's left edge and offset 0 had to skip the pad. `renderer.ts` now centres the padded quad on
  // the GLYPH box, so the region's left edge IS the first glyph's cell -- and the caret is anchored to
  // the region. Keeping the inset would put the caret half a pad right of the first character.
  const prefix = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  return context.measureText(prefix).width / pixelScale;
}

/** A rasterized string: the texture, the glyph box, and the raster pad around it. All logical units. */
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
      // The shadow is part of the RASTER, so it has to key it -- without this a font object that gains
      // or loses a shadow (a `SetShadowColor` from Lua, a per-state font swap) serves the old bitmap.
      spec.shadowOffset ? `${spec.shadowOffset.x},${spec.shadowOffset.y}` : '-',
      spec.shadowColor ?? '-',
      spec.shadowAlpha ?? '-',
      spec.align,
      // Wrapping changes the raster, so it has to key it: the same string at two widths is two
      // different textures, and without this the first width served the second.
      spec.wrapWidth ?? 0,
      // Both change the LINE BREAKING, so both change the raster and must key it.
      spec.maxLines ?? 0,
      spec.wordWrap === false ? 'nw' : '-',
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
    // THE SHADOW'S OFFSET IN DEVICE PIXELS, ROUNDED, and the rounding is not optional: the glyph quad
    // is snapped to the device grid (`renderer.ts`), so a shadow at a fractional device offset would
    // reintroduce exactly the bilinear smear that snapping removed -- on the darkest, highest-contrast
    // ink on the screen. `Math.round` on the whole product, once, so the shadow keeps its authored
    // direction at every window scale (at scale 0.717 the authored 1 unit rounds to 1 device px, not 0).
    // **Y IS FLIPPED HERE**: `FontSpec.shadowOffset` keeps FrameXML's `+y` UP and a canvas is `+y` DOWN,
    // and this is the one place that flip happens.
    const shadowDx = spec.shadowOffset ? Math.round(spec.shadowOffset.x * pixelScale) : 0;
    const shadowDy = spec.shadowOffset ? -Math.round(spec.shadowOffset.y * pixelScale) : 0;
    // The canvas grows by TWICE the shadow's reach on each axis so the glyph block stays CENTRED in it.
    // That is what keeps `pad` symmetric, which is the invariant `renderer.ts` relies on to inflate the
    // quad about the glyph box's centre -- an asymmetric pad would shift every shadowed string by half
    // the shadow. Costs a few device pixels of empty canvas on the side the shadow does not fall.
    const paddingH = PADDING_H * dpr + 2 * Math.abs(shadowDx);
    const paddingV = PADDING_V * dpr + 2 * Math.abs(shadowDy);
    const inset = paddingH / 2;

    const lines = wrapLines(text, spec, scale);
    const widest = Math.max(...lines.map((line) => context.measureText(line).width));
    const width = Math.ceil(widest) + paddingH;
    // A single line keeps EXACTLY the height it always had, so no existing caption's quad moves;
    // only a wrapped string takes the multi-line path.
    // The glyph block in DEVICE pixels -- what the quad's `size` reports (divided back to logical) and
    // what the padded canvas is grown from. Same arithmetic as `measureText`'s `blockHeight`, in the
    // other unit, so the measured rect and the drawn quad cannot disagree about the block.
    const glyphBlockHeight = Math.ceil(
      lines.length > 1
        ? lineHeight(spec) * (lines.length - 1) * pixelScale + spec.size * pixelScale
        : spec.size * pixelScale,
    );
    const height = glyphBlockHeight + paddingV;

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
      // EVERY LINE'S ORIGIN IS ROUNDED, not just the first, and that is the multi-line half of the
      // device-grid discipline `renderer.ts` starts. `step` is `(size + spacing) * pixelScale`, a
      // float, so line 2 of a wrapped block landed at a fractional offset and smeared exactly the way
      // an unsnapped quad did -- and `canvas.height / 2` is fractional whenever the height is odd.
      // Rounding INSIDE the canvas IS rounding to the device grid: the quad's own origin is snapped
      // and the draw is 1 texel : 1 device pixel, so an integer canvas coordinate is an integer device
      // pixel. `x` is rounded for the same reason -- CENTER and RIGHT both divide by two.
      const y = Math.round(
        lines.length > 1 ? paddingV / 2 + row * step + glyphHeight / 2 : canvas.height / 2,
      );
      const lineWidth = context.measureText(line).width;
      const x = Math.round(
        spec.align === 'CENTER'
          ? inset + (widest - lineWidth) / 2
          : spec.align === 'RIGHT'
            ? inset + (widest - lineWidth)
            : inset,
      );

      // THE SHADOW GOES FIRST -- it is BEHIND the glyphs -- and it is a FILL ONLY, never stroked.
      // The reference is explicit about that: the drop-shadow pass "must lay out IDENTICALLY to its
      // (possibly outlined) fill but never paints halos -- an outlined shadow would be a muddy black
      // blob" (`benilla/src/ui_text/layout/mod.rs:59-62`). `SystemFont_Shadow_Outline_Huge2`
      // (fonts.xml:138-143) is the font that makes the distinction observable: it authors BOTH.
      if (spec.shadowOffset && (shadowDx !== 0 || shadowDy !== 0)) {
        target.globalAlpha = spec.shadowAlpha ?? 1;
        target.fillStyle = spec.shadowColor ?? '#000000';
        target.fillText(line, x + shadowDx, y + shadowDy);
        target.globalAlpha = 1;
      }

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
    // NO MIPMAPS ON TEXT. `CanvasTexture` defaults to `generateMipmaps = true` and
    // `minFilter = LinearMipmapLinearFilter`, and a string is drawn at exactly 1 texel : 1 device
    // pixel (`renderer.ts` snaps the quad to the device grid, and the canvas is sized in device
    // pixels here) -- so the mip chain can never be the right level and any LOD the driver picks
    // above 0 is a half-resolution glyph blurred back up. It also costs a full pyramid per cached
    // string. `LinearFilter` on both is the exact fetch at the 1:1 scale the quad is drawn at.
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    const entry: Entry = {
      texture,
      // Nested under `size` deliberately: this is the exact shape `GlueRenderer` consumes
      // (`ResolvedSprite`), so a font string that forgets to carry its measured size is a TYPE
      // ERROR rather than a silent stretch-to-rect. It shipped flat once, and because `size` is
      // optional and excess properties are not checked on a returned value, every string on screen
      // was quietly stretched to its widget rect until a screenshot caught it.
      //
      // `size` is the GLYPH box and `pad` the raster bleed around it, reported separately for the
      // reason `measureText` gives at length: the glyph box is what the layout and every anchor into
      // this string mean, and the pad is the rasterizer's own stroke clearance. The renderer draws a
      // quad of `size + pad` centred on the glyph box.
      size: {
        // Logical units: the raster is denser (`pixelScale` includes `dpr`) but the quad it draws
        // onto must stay the same on-screen size regardless of display density.
        width: widest / pixelScale,
        height: glyphBlockHeight / pixelScale,
      },
      // TOTAL extra on each axis, not per side. Very nearly symmetric -- the only asymmetry is the
      // `Math.ceil` on the canvas width, at most one device pixel on the right -- so the renderer
      // splits it in half and no glyph moves by more than half a device pixel.
      pad: {
        x: (canvas.width - widest) / pixelScale,
        y: (canvas.height - glyphBlockHeight) / pixelScale,
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
