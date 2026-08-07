/**
 * The character body-texture bake: `CharSections`' layers blitted into ONE 512x512 mipped texture,
 * which is what texture type 1 on a character `.m2` actually wants.
 *
 * WHY CPU, AND WHY 512. Both were settled by measurement, not by argument, in
 * `docs/superpowers/research/2026-08-07-compositor-measurements.md`:
 *  - **CPU blit**, not a `WebGLRenderTarget`. The GPU is 14x faster (0.3 ms against 4.7 ms) and
 *    equally invisible next to the ~57 ms p50 source fetch that dominates either way, and the CPU
 *    path needs nothing new: `pipeline/blp/loader.js` already returns these files decoded, in a
 *    worker, as transferables. It also holds no VRAM for source layers, and it is what the reference
 *    does (`benilla-formats/src/characters/sections.rs:181-242`, `blit_over` at `:307-347`).
 *  - **512x512**, because the base skin IS the canvas and `HumanMaleSkin00_00.blp` measures 512x512
 *    with 10 authored mips (as does `TaurenMaleSkin00_00`, so it is not one file's quirk). 256 was
 *    measured NOT pixel-equivalent to 512 (mean abs difference 1.715/255, max error 144), because a
 *    DOWNSCALE of the re-authored 3.3.5a art is loss where a 2x point upscale of the vanilla-era
 *    scalp art is not.
 *
 * WHAT IS NOT HERE. Equipment: the eight `ItemDisplayInfo` region layers are pieces 7/8. The seam is
 * `BodyLayer[]` -- an ORDERED list, blitted in order, so equipment joins by appending to it. See
 * `EQUIP_TILES_512` below, which is already the doubled reference table, and the closing note on
 * `character-look.ts#bodyLayersFor` for the exact attach point.
 *
 * The split with `character-look.ts` is DBC against pixels, and it is also what keeps the two modules
 * acyclic: that file reads `CharSections` and builds the layer list, this one owns the tiles, the
 * kernel and the cache.
 */
import * as THREE from 'three';

import WorkerPool from '../../pipeline/worker/pool';
import { BLP_IMAGE_FORMAT } from '../../../wow-data-parser/blp/const';
import { CharacterAppearance } from '../../../network/protocol/types';

/** The composite is the base skin's own size. See the file comment. */
export const CANVAS = 512;

/**
 * The destination tiles, `[x, y, w, h]` in composite pixels.
 *
 * This is the reference's table (`benilla-formats/src/characters/sections.rs:31-35`: head upper
 * `(0,160,128,32)`, head lower `(0,192,128,64)`, pelvis `(128,96,128,64)`) with every number DOUBLED
 * for the 512 canvas -- and the confirmation that doubling is the right operation is that the 3.3.5a
 * art then lands 1:1 on three of the four tiles, measured off the live host:
 *
 *   HEAD_UPPER (0,320,256,64)   <- `HumanMaleFaceUpper04_00.blp`         256x64   1:1
 *   HEAD_LOWER (0,384,256,128)  <- `HumanMaleFaceLower04_00.blp`         256x128  1:1
 *   PELVIS     (256,192,256,128)<- `HumanMaleNakedPelvisSkin00_00.blp`   256x128  1:1
 *   BODY       (0,0,512,512)    <- `HumanMaleSkin00_00.blp`              512x512  1:1
 *
 * The layers that were NOT re-authored for 3.3.5a (`ScalpUpperHair02_05.blp` 128x32,
 * `ScalpLowerHair02_05.blp` 128x64, `FacialUpperHair01_05.blp` 128x32, `FacialLowerHair01_05.blp`
 * 128x64) are exactly half their tile, and `blitOver`'s `scale` handles that by replicating each
 * source texel -- see the mip-shift rule in `bakeLayers`.
 */
export const COMPOSITE_TILES = {
  BODY: [0, 0, CANVAS, CANVAS],
  HEAD_UPPER: [0, 320, 256, 64],
  HEAD_LOWER: [0, 384, 256, 128],
  PELVIS: [256, 192, 256, 128],
} as const;

/**
 * The eight equipment tiles, the reference's `EQUIP_TILES` (`sections.rs:39-47`) doubled, kept here
 * so piece 7 does not have to re-derive them. NOT USED YET -- equipment is out of this piece's scope
 * and nothing reads this constant. It is a table, not a code path.
 *
 * Note LEG_UPPER is deliberately the same rect as `PELVIS`: it is in the reference too, and it is why
 * a robe covers the underwear rather than sitting beside it. The underwear layer blits first, so
 * equipment lands on top.
 */
export const EQUIP_TILES_512: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 256, 128], // 0 ArmUpper
  [0, 128, 256, 128], // 1 ArmLower
  [0, 256, 256, 64], // 2 Hand
  [256, 0, 256, 128], // 3 TorsoUpper
  [256, 128, 256, 64], // 4 TorsoLower
  [256, 192, 256, 128], // 5 LegUpper -- the pelvis tile
  [256, 320, 256, 128], // 6 LegLower
  [256, 448, 256, 64], // 7 Foot
];

/** One blit: a BLP, and where it lands. The whole input to the bake, in order. */
export type BodyLayer = {
  /** Which tile, for reading a log or a test failure. Not used by the kernel. */
  tile: keyof typeof COMPOSITE_TILES;
  /** `[x, y, w, h]` in composite pixels. */
  rect: readonly [number, number, number, number];
  /** The BLP path exactly as the DBC spells it. */
  path: string;
};

/** What `pipeline/blp/loader.js` hands back through the worker for one source. */
type BlpSpec = {
  width: number;
  height: number;
  format: number;
  mipmaps: { width: number; height: number; data: Uint8Array }[];
};

/** A composite, plus what it cost -- the number the measurement doc asks to be reported honestly. */
export type BodyComposite = {
  texture: THREE.DataTexture;
  /** Layers actually blitted (a missing or compressed source is skipped, not fatal). */
  layers: number;
  /** ms for the blit + texture build, excluding the source fetch. Compare with the spike's 4.7 ms. */
  bakeMs: number;
  /** ms for the source fetches, which the measurement found dominate: p50 57 ms per cold source. */
  fetchMs: number;
};

/**
 * 8-bit source-over of one source mip into one dest tile: the reference's `blit_over` kernel
 * (`sections.rs:307-347`) -- alpha 0 skips (leave the base), alpha 255 copies (the client's REPLACE,
 * which is what an opaque face tile does), everything else blends. Rounding is the reference's
 * `+ 127` round-to-nearest, not a truncating divide.
 *
 * `scale` is 1 or 2, never anything else, and it is 2 only at dest level 0 of a layer whose art was
 * never re-authored for 3.3.5a. A factor of exactly two by nearest neighbour REPLICATES each source
 * texel: it invents no detail and discards none, and the composite's own mip 1 is then that layer's
 * authored resolution, so the chain stays honest all the way down. There is deliberately no
 * resampler here -- every scale factor in the whole layer set is 1 or 2.
 *
 * Extents are clamped to what the source and the destination actually hold, like the reference, so a
 * source that disagrees with its tile writes what fits instead of running off the row.
 */
function blitOver(
  dst: Uint8Array,
  dstW: number,
  dstH: number,
  src: Uint8Array,
  srcW: number,
  srcH: number,
  tx: number,
  ty: number,
  tw: number,
  th: number,
  scale: number,
): void {
  const cols = Math.min(srcW, Math.ceil(Math.max(0, Math.min(tw, dstW - tx)) / scale));
  const rows = Math.min(srcH, Math.ceil(Math.max(0, Math.min(th, dstH - ty)) / scale));
  for (let sy = 0; sy < rows; sy++) {
    for (let sx = 0; sx < cols; sx++) {
      const s = (sy * srcW + sx) * 4;
      const sa = src[s + 3];
      if (sa === 0) {
        continue;
      }
      const sr = src[s];
      const sg = src[s + 1];
      const sb = src[s + 2];
      for (let ry = 0; ry < scale; ry++) {
        const dy = ty + sy * scale + ry;
        if (dy >= dstH) {
          break;
        }
        for (let rx = 0; rx < scale; rx++) {
          const dx = tx + sx * scale + rx;
          if (dx >= dstW) {
            break;
          }
          const d = (dy * dstW + dx) * 4;
          if (sa === 255) {
            dst[d] = sr;
            dst[d + 1] = sg;
            dst[d + 2] = sb;
            dst[d + 3] = 255;
            continue;
          }
          const ia = 255 - sa;
          dst[d] = (sr * sa + dst[d] * ia + 127) / 255;
          dst[d + 1] = (sg * sa + dst[d + 1] * ia + 127) / 255;
          dst[d + 2] = (sb * sa + dst[d + 2] * ia + 127) / 255;
          dst[d + 3] = Math.min(255, sa + (dst[d + 3] * ia + 127) / 255);
        }
      }
    }
  }
}

/**
 * Blit the decoded sources into one mipped RGBA buffer set and wrap it in a `DataTexture`.
 *
 * PER-LAYER MIP SHIFT, which is the only arithmetic here that is not the reference's:
 * `shift = log2(tileWidth / sourceWidth)` -- taken from WIDTH alone, because every source measured has
 * its tile's aspect ratio exactly, and a source that did not would need a per-axis scale the reference
 * does not have either. It is
 * 0 for the base skin, the face tiles and the pelvis
 * (their 3.3.5a art is tile-sized), 1 for the scalp and facial-hair tiles (vanilla-era art, half its
 * tile). Dest level L reads source level `L - shift`; when that is negative -- which happens only at
 * dest level 0 of a shift-1 layer -- the source's level 0 is point-doubled instead. So exactly one
 * level of exactly some layers ever scales, and every other level is a 1:1 copy of an AUTHORED mip.
 *
 * `flipY = false` and `generateMipmaps = false`, the same convention as every other texture in this
 * client (`pipeline/texture-loader.js:110-117`); the mip chain is supplied, so regenerating it would
 * both cost time and disagree with the authored levels.
 */
function bakeLayers(layers: BodyLayer[], specs: (BlpSpec | null)[]): BodyComposite | null {
  const t0 = performance.now();

  const baseSpec = specs[0];
  if (!layers.length || layers[0].tile !== 'BODY' || !baseSpec) {
    return null;
  }

  // As many levels as the BASE SKIN authored, capped at the canvas's own chain length. Allocating
  // deeper than the base carries would leave the bottom levels transparent black and the texture
  // would darken at distance.
  let levels = 1;
  for (let s = CANVAS; s > 1; s >>= 1) {
    levels++;
  }
  levels = Math.min(levels, baseSpec.mipmaps.length);

  const mipmaps: { width: number; height: number; data: Uint8Array }[] = [];
  for (let level = 0; level < levels; level++) {
    const size = Math.max(1, CANVAS >> level);
    mipmaps.push({ width: size, height: size, data: new Uint8Array(size * size * 4) });
  }

  let blitted = 0;
  for (let i = 0; i < layers.length; i++) {
    const spec = specs[i];
    if (!spec) {
      continue;
    }
    const [tx, ty, tw, th] = layers[i].rect;
    const shift = Math.round(Math.log2(tw / spec.width));
    for (let level = 0; level < levels; level++) {
      const dst = mipmaps[level];
      const sourceLevel = level - shift;
      const scale = sourceLevel < 0 ? 1 << -sourceLevel : 1;
      const mip = spec.mipmaps[Math.max(0, sourceLevel)];
      if (!mip) {
        break;
      }
      blitOver(
        dst.data,
        dst.width,
        dst.height,
        mip.data,
        mip.width,
        mip.height,
        tx >> level,
        ty >> level,
        Math.max(1, tw >> level),
        Math.max(1, th >> level),
        scale,
      );
    }
    blitted++;
  }

  const texture = new THREE.DataTexture(mipmaps[0].data, CANVAS, CANVAS, THREE.RGBAFormat);
  texture.mipmaps = mipmaps as never;
  texture.generateMipmaps = false;
  texture.minFilter = levels > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.flipY = false;
  texture.anisotropy = 16;
  texture.name = `CharacterComposite(${layers[0].path})`;
  texture.needsUpdate = true;

  return { texture, layers: blitted, bakeMs: performance.now() - t0, fetchMs: 0 };
}

/**
 * Fetch every layer's BLP through the existing worker and bake them.
 *
 * COMPRESSED SOURCES ARE SKIPPED, NOT DECODED HERE. All 38 sources measured for this layer set come
 * back `format: IMAGE_ABGR8888` -- `pipeline/blp/loader.js:19-23` only leaves a level compressed when
 * the file is `COLOR_DXT`, and none of these files is. But that was a spot check of one appearance
 * and eight armour regions, not a sweep of ~40 000 `ItemDisplayInfo` rows, so a DXT layer may still
 * turn up: it is warned about and skipped (the character keeps every other layer), and if the BASE
 * SKIN is the compressed one the whole bake answers null and the caller falls back to binding that
 * BLP raw -- which is exactly what shipped before this file existed. Decoding it would mean asking
 * the worker for `IMAGE_ABGR8888` on a DXT file, which `wow-data-parser/blp/dxt.ts` already supports;
 * that is a one-line change to the worker's output format and is deliberately not made speculatively.
 */
export async function compositeBody(layers: BodyLayer[]): Promise<BodyComposite | null> {
  if (!layers.length) {
    return null;
  }

  const t0 = performance.now();
  // Concurrent, not sequential: measured 5.5 ms for the four sources a skin click needs against
  // 53.8-144 ms per source cold and sequential. `WorkerPool` de-duplicates by path, and the browser's
  // HTTP cache makes a re-selected character's sources free.
  const specs = await Promise.all(
    layers.map(async (layer) => {
      try {
        const spec = (await WorkerPool.enqueue('BLP', layer.path.toUpperCase())) as BlpSpec | null;
        if (!spec) {
          console.warn(`body composite: no BLP for ${layer.path}`);
          return null;
        }
        if (spec.format !== BLP_IMAGE_FORMAT.IMAGE_ABGR8888) {
          console.warn(
            `body composite: ${layer.path} came back format ${spec.format}, not decoded RGBA -- ` +
              'skipping the layer. See compositeBody for why this is a skip and not a decode.',
          );
          return null;
        }
        return spec;
      } catch (error) {
        console.warn(`body composite: ${layer.path} failed to load`, error);
        return null;
      }
    }),
  );
  const fetchMs = performance.now() - t0;

  const baked = bakeLayers(layers, specs);
  if (!baked) {
    return null;
  }
  return { ...baked, fetchMs };
}

/**
 * The appearance-tuple cache the measurement asks for: cycling a dial back, or re-selecting a roster
 * row, is a map hit and costs nothing.
 *
 * The cache OWNS its textures -- callers must not dispose one. That is deliberate and it is the
 * cheaper half of the pre-existing `loadTextures` reference problem: a composite does not go through
 * `TextureLoader` at all (see `M2Material#loadTextures`), so there is no reference count to leak, and
 * exactly one owner disposes it. Capacity 16 against a roster of at most 10 rows, evicting the least
 * recently used -- and the entry just handed out is the most recently used, so it can never be the
 * victim of the eviction that follows it.
 */
const CACHE_CAPACITY = 16;
const cache = new Map<string, BodyComposite>();

export function compositeCacheKey(
  race: number,
  gender: number,
  appearance: CharacterAppearance | null | undefined,
): string {
  return [
    race,
    gender,
    appearance?.skin ?? 0,
    appearance?.face ?? 0,
    appearance?.hairStyle ?? 0,
    appearance?.hairColor ?? 0,
    appearance?.facialHair ?? 0,
  ].join('/');
}

export async function cachedComposite(
  key: string,
  layers: BodyLayer[],
): Promise<BodyComposite | null> {
  const hit = cache.get(key);
  if (hit) {
    // Re-insert so the LRU order is use order, not insertion order.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const baked = await compositeBody(layers);
  if (!baked) {
    return null;
  }

  // Another selection of the same look may have raced this one; keep the first and drop this copy
  // rather than leaving two textures for one key with only one of them reachable to dispose.
  const raced = cache.get(key);
  if (raced) {
    baked.texture.dispose();
    return raced;
  }

  cache.set(key, baked);
  while (cache.size > CACHE_CAPACITY) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      break;
    }
    cache.get(oldest.value)?.texture.dispose();
    cache.delete(oldest.value);
  }
  return baked;
}

/** Drop every cached composite. For teardown; the glue app calls it from `stop()`. */
export function clearCompositeCache(): void {
  for (const entry of cache.values()) {
    entry.texture.dispose();
  }
  cache.clear();
}
