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
 * EQUIPMENT IS NOW HERE TOO, and it needed no kernel change -- the eight `ItemDisplayInfo` region
 * layers are just eight more entries in the same ordered `BodyLayer[]`, at the eight tiles below.
 * `character-equipment.ts` builds them; the ordering law and the gender suffix live there.
 *
 * The split with `character-look.ts` is DBC against pixels, and it is also what keeps the modules
 * acyclic: those files read the DBCs and build the layer list, this one owns the tiles, the kernel
 * and the cache.
 */
import * as THREE from 'three';

import WorkerPool, { PRIORITY } from '../../pipeline/worker/pool';
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

  // The eight equipment tiles, the reference's `EQUIP_TILES` (`sections.rs:39-47`) doubled the same
  // way. `EQUIP_TILE_NAMES` below fixes their LAYER ORDER, which is the load-bearing part: layer
  // index i == `ItemDisplayInfo` region column i == this tile.
  //
  // Note LEG_UPPER is deliberately the same rect as `PELVIS` -- it is in the reference too
  // (`sections.rs:37`, "g5 == TILE_G5"), and it is why trousers cover the underwear rather than
  // sitting beside it: the underwear layer blits first, so equipment lands on top.
  ARM_UPPER: [0, 0, 256, 128],
  ARM_LOWER: [0, 128, 256, 128],
  HAND: [0, 256, 256, 64],
  TORSO_UPPER: [256, 0, 256, 128],
  TORSO_LOWER: [256, 128, 256, 64],
  LEG_UPPER: [256, 192, 256, 128],
  LEG_LOWER: [256, 320, 256, 128],
  FOOT: [256, 448, 256, 64],
} as const;

/**
 * The eight equipment tiles in **layer order** -- `ItemDisplayInfo` region column *i* is compositor
 * layer *i* is this tile (`sections.rs:36-47`). `character-equipment.ts` indexes this.
 *
 * MEASURED CORRECTION to the assumption that "every region is exactly half its tile". It is not: a
 * stratified sample of 508 of the 15 666 distinct region names on the live host measured
 * 303x 128x64, 107x 128x32 (vanilla-era, half their tile) but also **63x 256x128 and 23x 256x64**
 * (re-authored for 3.3.5a, exactly tile-sized). So ~17% of equipment art takes mip shift 0 and the
 * rest shift 1. `bakeLayers` derives the shift per layer from the source's own width, so this needed
 * no code -- but a hardcoded "always double" would have drawn one in six items at quarter size.
 */
export const EQUIP_TILE_NAMES = [
  'ARM_UPPER',
  'ARM_LOWER',
  'HAND',
  'TORSO_UPPER',
  'TORSO_LOWER',
  'LEG_UPPER',
  'LEG_LOWER',
  'FOOT',
] as const satisfies readonly (keyof typeof COMPOSITE_TILES)[];

/** One blit: a BLP, and where it lands. The whole input to the bake, in order. */
export type BodyLayer = {
  /** Which tile, for reading a log or a test failure. Not used by the kernel. */
  tile: keyof typeof COMPOSITE_TILES;
  /** `[x, y, w, h]` in composite pixels. */
  rect: readonly [number, number, number, number];
  /** The BLP path exactly as the DBC spells it. */
  path: string;
  /**
   * Paths to try, in order, if `path` does not resolve -- the reference's own suffix loop
   * (`read_equip_region`, `sections.rs:288-299`). Only equipment layers set this: an item's region
   * art ships `_M`/`_F` for a gendered cut and `_U` for the unisex majority, and which one exists is
   * not derivable from the DBC. `CharSections` layers carry a path the table states outright and
   * leave this undefined.
   */
  alternates?: readonly string[];
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
 * One layer's source: its own path, then its `alternates` in order, first one that decodes.
 *
 * A MISS IS EXPECTED HERE, and only for equipment. `path` is the gendered `_M`/`_F` candidate and the
 * unisex `_U` is the shipped majority, so the common equipment layer costs one 404 before its real
 * file -- the reference pays the same, walking the same three suffixes against its archive
 * (`sections.rs:288-299`). Layers are resolved concurrently with each other, so the miss adds one
 * round trip to the whole bake rather than one per layer.
 *
 * A COMPRESSED SOURCE IS DECODED, NOT SKIPPED. `pipeline/blp/loader.js` leaves DXT levels compressed
 * for the GPU, which is right for every other consumer and useless to a CPU blit, so the bake asks
 * for `decompress` and gets ABGR8888 for a DXT file too (`wow-data-parser/blp/dxt.ts` was always
 * there; nothing decoded it for this path). Measured: no DXT source has yet turned up in a character
 * layer set -- all 38 `CharSections` sources and a stratified 508-name sample of the 15 666 distinct
 * `ItemDisplayInfo` region names are palettized -- but that is a sample of ~3%, and this is the one
 * place a sweep could not be completed, so the fallback is a real decode instead of a warning.
 */
async function loadLayerSource(layer: BodyLayer): Promise<BlpSpec | null> {
  const candidates = [layer.path, ...(layer.alternates ?? [])];
  for (const candidate of candidates) {
    try {
      // CHARACTER priority: these are the layers of a visible character's skin, and the atlas
      // cannot be composited until the LAST of them arrives -- so one layer stuck behind a
      // terrain burst holds the whole bake, and the character stands in his base skin until it
      // clears. See `worker/pool.js#PRIORITY`.
      // QUIET: the gendered name missing is the normal path to the `_U` file, said two lines down,
      // and the pool logged a stack trace for it twice per miss. `enqueueQuietAt` silences the log
      // and nothing else -- the loop below still falls through exactly as before.
      const spec = (await WorkerPool.enqueueQuietAt(
        PRIORITY.CHARACTER, 'BLP', candidate.toUpperCase(), true,
      )) as
        | BlpSpec
        | null
        | undefined;
      if (!spec) {
        continue;
      }
      if (spec.format !== BLP_IMAGE_FORMAT.IMAGE_ABGR8888) {
        // Unreachable through `decompress` for BLP2's three colour formats; kept because a format
        // this kernel cannot read must be named rather than blitted as if it were RGBA.
        console.warn(`body composite: ${candidate} came back format ${spec.format}, not RGBA`);
        continue;
      }
      return spec;
    } catch (error) {
      // Not warned per candidate: a 404 on the gendered name is the NORMAL path to the `_U` file.
      void error;
    }
  }
  console.warn(`body composite: no BLP resolved for ${candidates.join(' / ')}`);
  return null;
}

/** Fetch every layer's BLP through the existing worker and bake them. */
export async function compositeBody(layers: BodyLayer[]): Promise<BodyComposite | null> {
  if (!layers.length) {
    return null;
  }

  const t0 = performance.now();
  // Concurrent, not sequential: measured 5.5 ms for the four sources a skin click needs against
  // 53.8-144 ms per source cold and sequential. The browser's HTTP cache makes a re-selected
  // character's sources free.
  const specs = await Promise.all(layers.map(loadLayerSource));
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
  /**
   * The worn display ids, which are half the key now that equipment is half the composite -- the
   * reference keys the same cache the same way (`SkinKey { …, equip: [u32; 8] }`,
   * `benilla/src/entities.rs:309`). The WHOLE array is folded in rather than just the eight bodyslots:
   * it is eleven more numbers, it costs nothing, and it means a key can never collide across a gear
   * change that this file does not happen to know is invisible.
   */
  equipment?: { displayId: number }[] | null,
): string {
  return [
    race,
    gender,
    appearance?.skin ?? 0,
    appearance?.face ?? 0,
    appearance?.hairStyle ?? 0,
    appearance?.hairColor ?? 0,
    appearance?.facialHair ?? 0,
    (equipment ?? []).map((slot) => slot?.displayId ?? 0).join(','),
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
