/**
 * MEASUREMENT SPIKE -- not the compositor, and not on any code path.
 *
 * Piece 5 of `docs/superpowers/research/2026-08-07-character-model-findings.md` needs the body-texture
 * bake, and its §6 unknown 4 asks where the bake belongs: a CPU blit into an RGBA buffer, or a render
 * into a `WebGLRenderTarget`. That is not answerable by reading, so this file exists to answer it with
 * numbers, on real BLPs from the real asset host, in the real browser.
 *
 * INERT BY DEFAULT. `installBakeSpike` only publishes `window.bakeSpike`; nothing here runs, allocates
 * a target, or touches a material until a console call asks it to. Same shape and same reason as
 * `installFramexmlDebug` (`ui/framexml/debug.ts`) and `skyDebug` (`pipeline/sky/debug/index.ts`).
 *
 * DELETE THIS FILE, and its one call in `ui/screens.ts`, when piece 5 lands. It is a decision record,
 * not a component.
 *
 *   bakeSpike.help()
 */
import * as THREE from 'three';

import WorkerPool from '../../pipeline/worker/pool';

/**
 * The composite tile table, at 512.
 *
 * benilla's table is authored for its 1.12.1 canvas of 256 (`benilla-formats/src/characters/
 * sections.rs:31-47`: head upper `(0,160,128,32)`, head lower `(0,192,128,64)`, pelvis
 * `(128,96,128,64)`). Every rect below is exactly twice that, and the 3.3.5a art measured off the host
 * lands in it 1:1 -- `HumanMaleFaceUpper04_00.blp` is 256x64 against a 256x64 tile,
 * `HumanMaleFaceLower04_00` 256x128 against 256x128, `HumanMaleNakedPelvisSkin00_00` 256x128 against
 * 256x128, and `HumanMaleSkin00_00` is 512x512 against the whole canvas.
 */
const TILES: Record<string, [number, number, number, number]> = {
  BODY: [0, 0, 512, 512],
  HEAD_UPPER: [0, 320, 256, 64],
  HEAD_LOWER: [0, 384, 256, 128],
  PELVIS: [256, 192, 256, 128],
  // The eight `ItemDisplayInfo` region tiles (`sections.rs:39-46` doubled). PELVIS and LEG_UPPER are
  // deliberately the same rect -- they are in the reference too, which is why a robe covers the
  // underwear rather than sitting beside it.
  ARM_UPPER: [0, 0, 256, 128],
  ARM_LOWER: [0, 128, 256, 128],
  HAND: [0, 256, 256, 64],
  TORSO_UPPER: [256, 0, 256, 128],
  TORSO_LOWER: [256, 128, 256, 64],
  LEG_UPPER: [256, 192, 256, 128],
  LEG_LOWER: [256, 320, 256, 128],
  FOOT: [256, 448, 256, 64],
};

type SpikeLayer = { tile: string; src: string };
type SpikeStep = { step: number; dial: string; layers: SpikeLayer[] };

/** What `pipeline/blp/loader.js` hands back through the worker. */
type BlpSpec = {
  width: number;
  height: number;
  format: number;
  mipmaps: { width: number; height: number; data: Uint8Array }[];
};

const sources = new Map<string, BlpSpec>();
const gpuTextures = new Map<string, THREE.DataTexture>();

function mipLevels(size: number): number {
  let n = 1;
  let s = size;
  while (s > 1) { s >>= 1; n++; }
  return n;
}

/**
 * Straight 8-bit source-over of one source mip into one dest tile, the kernel benilla calls
 * `blit_over` (`sections.rs:307-347`): alpha 0 skips, alpha 255 copies, everything else blends.
 *
 * `scale` is 1 or 2. It is 2 only at dest level 0 of a layer whose art was never re-authored for
 * 3.3.5a -- scalp, facial hair and every `Item\TextureComponents` region still ship at the vanilla 1x
 * size (measured: `ScalpUpperHair02_05.blp` 128x32 against a 256x64 tile). A factor of exactly 2 by
 * nearest neighbour replicates each source texel, so it invents nothing and discards nothing.
 */
function blitOver(
  dst: Uint8Array, dstW: number,
  src: Uint8Array, srcW: number, srcH: number,
  tx: number, ty: number, scale: number,
): void {
  for (let sy = 0; sy < srcH; sy++) {
    for (let sx = 0; sx < srcW; sx++) {
      const s = (sy * srcW + sx) * 4;
      const sa = src[s + 3];
      if (sa === 0) continue;
      const sr = src[s]; const sg = src[s + 1]; const sb = src[s + 2];
      for (let ry = 0; ry < scale; ry++) {
        for (let rx = 0; rx < scale; rx++) {
          const d = ((ty + sy * scale + ry) * dstW + (tx + sx * scale + rx)) * 4;
          if (sa === 255) {
            dst[d] = sr; dst[d + 1] = sg; dst[d + 2] = sb; dst[d + 3] = 255;
            continue;
          }
          const ia = 255 - sa;
          dst[d] = (sr * sa + dst[d] * ia) / 255;
          dst[d + 1] = (sg * sa + dst[d + 1] * ia) / 255;
          dst[d + 2] = (sb * sa + dst[d + 2] * ia) / 255;
          dst[d + 3] = sa + (dst[d + 3] * ia) / 255;
        }
      }
    }
  }
}

/** OPTION A: decode-and-blit on the CPU, then upload one composed RGBA texture. */
function cpuBake(step: SpikeStep, canvas: number, allMips: boolean) {
  const t0 = performance.now();
  const levels = allMips ? mipLevels(canvas) : 1;
  const mips: { width: number; height: number; data: Uint8Array }[] = [];
  for (let L = 0; L < levels; L++) {
    const w = Math.max(1, canvas >> L);
    mips.push({ width: w, height: w, data: new Uint8Array(w * w * 4) });
  }
  const tAlloc = performance.now();

  let blits = 0;
  for (const layer of step.layers) {
    const spec = sources.get(layer.src.toUpperCase());
    if (!spec) continue;
    // The tile rects are authored for a 512 canvas; a different canvas scales them.
    const k = canvas / 512;
    const [tx0, ty0, tw0] = TILES[layer.tile];
    const tx = tx0 * k; const ty = ty0 * k; const tw = tw0 * k;
    // How far the source sits from its tile, in mip levels. `shift = +1` is a layer whose art is half
    // its tile (every 1x-era scalp, facial-hair and item region against a 512 canvas): level 0 needs a
    // 2x point upscale and every level below it lands 1:1 against a coarser source mip. `shift = -1`
    // is the opposite -- the source is twice its tile, which is what a 256 canvas does to all the
    // re-authored 3.3.5a art -- and there the bake reads the source's own next mip down.
    const shift = Math.round(Math.log2(tw / spec.width));
    for (let L = 0; L < levels; L++) {
      const dstW = Math.max(1, canvas >> L);
      const si = L - shift;
      const scale = si < 0 ? 1 << -si : 1;
      const mip = spec.mipmaps[Math.max(0, si)];
      if (!mip) break;
      if ((tw >> L) < 1) break;
      blitOver(mips[L].data, dstW, mip.data, mip.width, mip.height, tx >> L, ty >> L, scale);
      blits++;
    }
  }
  const tBlit = performance.now();

  const tex = new THREE.DataTexture(mips[0].data, canvas, canvas, THREE.RGBAFormat);
  tex.mipmaps = mips as never;
  tex.generateMipmaps = false;
  tex.minFilter = levels > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.flipY = false;
  tex.needsUpdate = true;
  const tBuild = performance.now();

  return {
    tex, blits, levels,
    alloc: tAlloc - t0,
    blit: tBlit - tAlloc,
    build: tBuild - tBlit,
    total: tBuild - t0,
    bytes: mips.reduce((s, m) => s + m.data.length, 0),
  };
}

/**
 * A source texture on the GPU, for option B. Built once per source and cached, as the real thing would.
 *
 * `flipY = true` here, against this client's otherwise uniform `flipY = false`
 * (`pipeline/texture-loader.js`), and the reason is that this is the one place a BLP is sampled by a
 * quad rather than by an M2. `PlaneGeometry`'s UV has `v = 0` at the bottom, so a `flipY = false`
 * texture draws its first row -- the image's TOP row -- along the quad's bottom edge, i.e. upside
 * down. `verify()` below pins this by pixel comparison against the CPU kernel rather than by argument.
 */
function gpuSource(path: string, flipY: boolean): THREE.DataTexture | null {
  const key = `${path.toUpperCase()}|${flipY}`;
  const have = gpuTextures.get(key);
  if (have) return have;
  const spec = sources.get(path.toUpperCase());
  if (!spec) return null;
  const tex = new THREE.DataTexture(spec.mipmaps[0].data, spec.width, spec.height, THREE.RGBAFormat);
  tex.generateMipmaps = false;
  // NEAREST so the 1x layers magnify to their tile by exact texel replication, which is what the CPU
  // kernel above does. Any comparison between the two options has to blend identically or the numbers
  // are measuring two different pictures.
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.flipY = flipY;
  tex.needsUpdate = true;
  gpuTextures.set(key, tex);
  return tex;
}

/** OPTION B: render the layers into a `WebGLRenderTarget` and sample that. */
class GpuBaker {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private readonly quads: THREE.Mesh[] = [];
  target: THREE.WebGLRenderTarget | null = null;
  targetSetupMs = 0;

  /** Source-texture orientation. `verify()` sweeps it; `bake()` defaults to the one that matches. */
  srcFlipY = true;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly canvas: number) {
    this.camera = new THREE.OrthographicCamera(0, canvas, canvas, 0, -1, 1);
    this.scene.matrixWorldAutoUpdate = true;
  }

  ensureTarget(mips: boolean) {
    if (this.target) return;
    const t0 = performance.now();
    this.target = new THREE.WebGLRenderTarget(this.canvas, this.canvas, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: mips,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    } as never);
    // Force the allocation now rather than on the first render, so the setup cost is attributed here.
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(prev);
    this.renderer.getContext().finish();
    this.targetSetupMs = performance.now() - t0;
  }

  bake(step: SpikeStep, mips: boolean) {
    this.ensureTarget(mips);
    const t0 = performance.now();

    // Rebuild the draw list. A real compositor would pool these; the pool is a handful of quads and
    // building them is measured separately below so it can be discounted.
    for (const q of this.quads) this.scene.remove(q);
    this.quads.length = 0;
    let order = 0;
    for (const layer of step.layers) {
      const tex = gpuSource(layer.src, this.srcFlipY);
      if (!tex) continue;
      const k = this.canvas / 512;
      const [tx0, ty0, tw0, th0] = TILES[layer.tile];
      const tx = tx0 * k; const ty = ty0 * k; const tw = tw0 * k; const th = th0 * k;
      const geom = new THREE.PlaneGeometry(tw, th);
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
        premultipliedAlpha: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      // The canvas origin is top-left (`flipY = false` everywhere in this client), and the ortho
      // camera's Y grows upward, so a tile at dest y lands at canvas - y - h.
      mesh.position.set(tx + tw / 2, this.canvas - ty - th / 2, 0);
      mesh.renderOrder = order++;
      this.scene.add(mesh);
      this.quads.push(mesh);
    }
    const tBuild = performance.now();

    // Every borrowed flag is put back as it was FOUND, not as this code would like it. The glue
    // renderer runs with `autoClear = false` on purpose (`ui/renderer.ts:1-10`: the widget pass draws
    // over the 3D pass), so a bake that left `autoClear = true` behind would blank the UI layer.
    const prevTarget = this.renderer.getRenderTarget();
    const prevAuto = this.renderer.autoClear;
    const prevSort = this.renderer.sortObjects;
    this.renderer.autoClear = true;
    this.renderer.sortObjects = false;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.autoClear = prevAuto;
    this.renderer.sortObjects = prevSort;
    const tSubmit = performance.now();

    this.renderer.getContext().finish();
    const tFinish = performance.now();

    return {
      draws: this.quads.length,
      build: tBuild - t0,
      submit: tSubmit - tBuild,
      finish: tFinish - tSubmit,
      total: tFinish - t0,
      setup: this.targetSetupMs,
    };
  }

  dispose() {
    for (const q of this.quads) {
      (q.material as THREE.Material).dispose();
      q.geometry.dispose();
      this.scene.remove(q);
    }
    this.quads.length = 0;
    this.target?.dispose();
    this.target = null;
  }
}

function stats(xs: number[]) {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: +s[0].toFixed(2),
    p50: +s[s.length >> 1].toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    mean: +(sum / s.length).toFixed(2),
  };
}

export function installBakeSpike(renderer: THREE.WebGLRenderer): void {
  (window as never as Record<string, unknown>).bakeSpike = {
    help() {
      console.log([
        'bakeSpike.prefetch(paths)      fetch + worker-decode every source; reports per-source ms',
        'bakeSpike.encodings()          what the loader actually returned per source (DXT or not)',
        'bakeSpike.run(sequence, opts)  measure CPU and GPU bakes over a step sequence',
        '  opts: { canvas = 512, allMips = true, repeats = 5 }',
        'bakeSpike.preview(step, how)   bake one step and return a data: URL to look at',
        'bakeSpike.reset()              drop every cached source and GPU texture',
      ].join('\n'));
    },

    async prefetch(paths: string[]) {
      const per: { path: string; ms: number; w: number; h: number; format: number; mips: number }[] = [];
      const t0 = performance.now();
      for (const p of paths) {
        const key = p.toUpperCase();
        if (sources.has(key)) continue;
        const t = performance.now();
        const spec = (await WorkerPool.enqueue('BLP', key)) as BlpSpec;
        const ms = performance.now() - t;
        if (!spec) { console.warn(`bakeSpike: no spec for ${p}`); continue; }
        sources.set(key, spec);
        per.push({ path: p, ms: +ms.toFixed(2), w: spec.width, h: spec.height, format: spec.format, mips: spec.mipmaps.length });
      }
      return { wallMs: +(performance.now() - t0).toFixed(2), count: per.length, per, stats: stats(per.map((x) => x.ms)) };
    },

    /**
     * Does the GPU bake produce the SAME PICTURE as the CPU kernel?
     *
     * Sweeps the two orientation choices -- source `flipY`, and whether the readback needs a row flip
     * -- and reports mean absolute per-channel difference for each. A claim that the two options are
     * interchangeable is worth nothing without this number.
     */
    verify(step: SpikeStep, canvas = 512) {
      const cpu = cpuBake(step, canvas, false);
      const ref = cpu.tex.image.data as Uint8Array;
      const baker = new GpuBaker(renderer, canvas);
      const rows = canvas * 4;
      const results: Record<string, { mad: number; maxDiff: number; exact: number }> = {};
      for (const srcFlipY of [true, false]) {
        baker.srcFlipY = srcFlipY;
        baker.bake(step, false);
        const raw = new Uint8Array(canvas * canvas * 4);
        renderer.readRenderTargetPixels(baker.target!, 0, 0, canvas, canvas, raw);
        for (const readbackFlip of [true, false]) {
          let got = raw;
          if (readbackFlip) {
            const f = new Uint8Array(raw.length);
            for (let y = 0; y < canvas; y++) f.set(raw.subarray(y * rows, y * rows + rows), (canvas - 1 - y) * rows);
            got = f;
          }
          let sum = 0; let max = 0; let exact = 0;
          for (let i = 0; i < ref.length; i++) {
            const d = Math.abs(ref[i] - got[i]);
            sum += d;
            if (d > max) max = d;
            if (d === 0) exact++;
          }
          results[`srcFlipY=${srcFlipY},readbackFlip=${readbackFlip}`] = {
            mad: +(sum / ref.length).toFixed(3),
            maxDiff: max,
            exact: +((exact / ref.length) * 100).toFixed(2),
          };
        }
      }
      baker.dispose();
      cpu.tex.dispose();
      return results;
    },

    /** Decoded-RGBA footprint of every cached source, which is what a CPU blit has to keep resident. */
    sourceBytes() {
      let level0 = 0; let allLevels = 0;
      for (const spec of sources.values()) {
        level0 += spec.mipmaps[0].data.length;
        for (const m of spec.mipmaps) allLevels += m.data.length;
      }
      return { count: sources.size, level0, allLevels };
    },

    /**
     * Fetch + worker decode, measured with the sources ALREADY cached by the browser's HTTP cache, so
     * what is left is decode plus the worker round trip -- the part a bigger network cannot hide.
     */
    async decodeOnly(paths: string[]) {
      const per: number[] = [];
      for (const p of paths) {
        const t = performance.now();
        const spec = await WorkerPool.enqueue('BLP', p.toUpperCase());
        if (spec) per.push(performance.now() - t);
      }
      return stats(per);
    },

    /** The whole set at once, which is what a real loader would do: how much does concurrency buy? */
    async parallel(paths: string[]) {
      const t = performance.now();
      await Promise.all(paths.map((p) => WorkerPool.enqueue('BLP', p.toUpperCase())));
      return { wallMs: +(performance.now() - t).toFixed(2), count: paths.length };
    },

    /**
     * Could the CPU blit move off the main thread? The blit is pure typed-array maths, so the only
     * new cost is shipping the composite back. This measures a transferable postMessage of exactly the
     * composite's size, both ways, against a throwaway worker.
     */
    async transferCost(bytes = 1398100, rounds = 20) {
      const src = 'self.onmessage = (e) => self.postMessage(e.data, [e.data.buffer]);';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const worker = new Worker(url);
      const per: number[] = [];
      for (let i = 0; i < rounds; i++) {
        const buf = new Uint8Array(bytes);
        const t = performance.now();
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          worker.onmessage = () => resolve();
          worker.postMessage(buf, [buf.buffer]);
        });
        per.push(performance.now() - t);
      }
      worker.terminate();
      URL.revokeObjectURL(url);
      return { bytes, roundTrip: stats(per) };
    },

    encodings() {
      // IMAGE_ABGR8888 = 5 in wow-data-parser/blp/const; the DXT formats are 2/3/4.
      const out: Record<string, number> = {};
      for (const [k, v] of sources) {
        const tag = `format:${v.format}`;
        out[tag] = (out[tag] || 0) + 1;
        void k;
      }
      return out;
    },

    async run(sequence: { steps: SpikeStep[]; allSources: string[] }, opts: Record<string, number | boolean> = {}) {
      const canvas = (opts.canvas as number) ?? 512;
      const allMips = (opts.allMips as boolean) ?? true;
      const repeats = (opts.repeats as number) ?? 5;

      const fetchReport = await (this as never as { prefetch(p: string[]): Promise<unknown> })
        .prefetch(sequence.allSources);

      const baker = new GpuBaker(renderer, canvas);
      const perStep: Record<string, unknown>[] = [];

      for (const step of sequence.steps) {
        const cpuRuns: ReturnType<typeof cpuBake>[] = [];
        for (let r = 0; r < repeats; r++) {
          const out = cpuBake(step, canvas, allMips);
          cpuRuns.push(out);
          if (r < repeats - 1) out.tex.dispose();
        }
        // The upload is a separate, once-per-bake cost and only the renderer can force it.
        const upload: number[] = [];
        for (let r = 0; r < repeats; r++) {
          const out = cpuBake(step, canvas, allMips);
          const t = performance.now();
          renderer.initTexture(out.tex);
          renderer.getContext().finish();
          upload.push(performance.now() - t);
          out.tex.dispose();
        }

        const gpuRuns: ReturnType<GpuBaker['bake']>[] = [];
        for (let r = 0; r < repeats; r++) gpuRuns.push(baker.bake(step, allMips));

        perStep.push({
          step: step.step,
          dial: step.dial,
          layers: step.layers.length,
          cpu: {
            alloc: stats(cpuRuns.map((x) => x.alloc)),
            blit: stats(cpuRuns.map((x) => x.blit)),
            build: stats(cpuRuns.map((x) => x.build)),
            total: stats(cpuRuns.map((x) => x.total)),
            upload: stats(upload),
            blits: cpuRuns[0].blits,
            bytes: cpuRuns[0].bytes,
          },
          gpu: {
            build: stats(gpuRuns.map((x) => x.build)),
            submit: stats(gpuRuns.map((x) => x.submit)),
            finish: stats(gpuRuns.map((x) => x.finish)),
            total: stats(gpuRuns.map((x) => x.total)),
            draws: gpuRuns[0].draws,
          },
        });
        cpuRuns[cpuRuns.length - 1].tex.dispose();
      }

      const cpuTotals = perStep.map((s) => (s.cpu as never as { total: { p50: number }; upload: { p50: number } }));
      const gpuTotals = perStep.map((s) => (s.gpu as never as { total: { p50: number } }));
      const summary = {
        canvas, allMips, repeats,
        targetSetupMs: +baker.targetSetupMs.toFixed(2),
        cpuPerChangeP50: stats(cpuTotals.map((c) => c.total.p50 + c.upload.p50)),
        gpuPerChangeP50: stats(gpuTotals.map((g) => g.total.p50)),
        gl: (() => {
          const gl = renderer.getContext();
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          return dbg ? gl.getParameter((dbg as never as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL) : 'unknown';
        })(),
        memory: (performance as never as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory,
        rendererInfo: JSON.parse(JSON.stringify(renderer.info)),
      };
      baker.dispose();
      return { summary, fetchReport, perStep };
    },

    /** Bake one step and hand back a PNG data URL, so the two options can be compared by eye. */
    async preview(step: SpikeStep, how: 'cpu' | 'gpu', canvas = 512) {
      const el = document.createElement('canvas');
      el.width = canvas; el.height = canvas;
      const ctx = el.getContext('2d')!;
      let rgba: Uint8Array;
      if (how === 'cpu') {
        const out = cpuBake(step, canvas, false);
        rgba = out.tex.image.data as Uint8Array;
        out.tex.dispose();
      } else {
        const baker = new GpuBaker(renderer, canvas);
        baker.bake(step, false);
        rgba = new Uint8Array(canvas * canvas * 4);
        renderer.readRenderTargetPixels(baker.target!, 0, 0, canvas, canvas, rgba);
        baker.dispose();
      }
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), canvas, canvas), 0, 0);
      return el.toDataURL('image/png');
    },

    reset() {
      for (const t of gpuTextures.values()) t.dispose();
      gpuTextures.clear();
      sources.clear();
    },
  };
}
