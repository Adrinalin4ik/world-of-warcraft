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
  /**
   * Load with REPEAT wrapping instead of clamped, for a sheet the client TILES -- a `Backdrop`'s
   * `bgFile` at its `TileSize`. Only safe on a whole-texture sprite, which is why it is opt-in per
   * sprite rather than the default: see `load()`.
   */
  tile?: boolean;
  /**
   * This key's texture is SUPPLIED, not fetched -- see `adopt`.
   *
   * `load()` skips it (there is no file to get) and `dispose()` does not release it (the owner that
   * made it releases it). The only supplier today is the model booth's render target
   * (`scene/model-booth.ts`), and the flag rather than a second table is what keeps `resolveSprite`
   * unchanged: a pane's pixels reach the draw pass by exactly the route every other sprite's do.
   */
  external?: boolean;
}

export class GlueArt {
  private readonly defs = new Map<string, SpriteDef>();
  private readonly textures = new Map<string, THREE.Texture>();
  /**
   * The path each loaded key was loaded FROM, so `load()` can tell a cached texture apart from a
   * stale one.
   *
   * One `GlueArt` outlives every screen (`GlueApp` owns it), and two screens may use the same key
   * name for different art -- `AccountLogin`'s Okay button is the `-Blue` sheet, `RealmList`'s is the
   * plain one, and both are naturally called `button-up`. Keying the load only on "is this key
   * loaded" meant whichever screen mounted FIRST won for the rest of the session, silently, with the
   * later screen's `register` call recorded in `defs` and ignored here.
   */
  private readonly loadedFrom = new Map<string, string>();
  /**
   * Bumped by `dispose()`. `load()` captures the value in flight and compares it after the
   * `TextureLoader` fetch resolves -- a mismatch means disposal ran while that fetch was still in
   * the air, so the reference it just acquired gets released instead of landing in a dead
   * instance's map, and instead of being stranded in `TextureLoader`'s reference count forever.
   */
  private generation = 0;

  register(key: string, def: SpriteDef): void {
    this.defs.set(key, def);
  }

  registerAll(table: Record<string, SpriteDef>): void {
    Object.entries(table).forEach(([key, def]) => this.register(key, def));
  }

  /**
   * Publish a texture this table did not fetch, under a key the draw pass can name.
   *
   * The one caller is the model booth: a `<PlayerModel>` pane's pixels are a render target, not a
   * BLP, and `resolveSprite` resolves a widget's pixels through `art.texture(widget.sprite)` and
   * nothing else. Adopting the target under a key is therefore what lets a rendered model take part
   * in the ordinary draw list -- at the pane's real draw layer, under the tooltips and over the panel
   * art -- instead of being stamped over the finished composite the way the cooldown sweeps and the
   * cursor icon are. Those two are drawn late because they MOVE every frame; a pane does not (see
   * `model-booth.ts` on the redraw policy), so it can afford to be a real sprite.
   *
   * `texCoords` is the caller's, and the booth passes a V-FLIPPED rect: a `WebGLRenderTarget`'s
   * texture has v = 0 at the BOTTOM, while every texture in this renderer loads `flipY = false` so
   * `v = 0` is the top row (`renderer.ts#writeQuadUVs`). Reversed coordinates are supported all the
   * way to the `uv` attribute -- the client's own `CharacterSelectRotateLeft` mirrors a sheet exactly
   * that way -- so the flip is one def field rather than a texture clone or a negated `repeat.y`.
   *
   * Idempotent by identity: re-adopting the same texture under the same key is a no-op, which is what
   * lets the booth call this every frame without churning `defs`.
   */
  adopt(key: string, texture: THREE.Texture, texCoords?: TexCoords): void {
    if (this.textures.get(key) === texture) {
      return;
    }
    // A key that previously held a FETCHED texture has to give its reference back before it is
    // repurposed -- the same rule `load()` applies when a key's art changes.
    const stale = this.textures.get(key);
    if (stale && !this.defs.get(key)?.external) {
      TextureLoader.unload(stale);
    }
    this.defs.set(key, { path: key, external: true, texCoords });
    this.textures.set(key, texture);
    this.loadedFrom.delete(key);
  }

  /**
   * Glue art paths are conventionally extensionless, as declared in the game's GlueXML.
   * The engine supplies `.blp` at load time. This helper appends it when absent, leaving
   * paths that already carry an extension untouched (some client data does specify `.blp`
   * explicitly, and future tables may as well).
   */
  private appendBLP(path: string): string {
    /**
     * A NON-BLP EXTENSION IS REPLACED, NOT KEPT, and the owner's console is the evidence:
     *
     *     glue art missing: Interface\Glues\Login\Glues-KoreanRating-Age.tga
     *     Failed to decode texture: INTERFACE\GLUES\LOGIN\GLUES-KOREANRATING-AGE.TGA
     *
     * The client's own files name a few textures with a source extension -- `.tga` here, and `.png`
     * elsewhere in the same family -- because that is what the ARTIST delivered; the shipped asset is
     * the compiled BLP beside it. Verified against the host: `glues-koreanrating-age.blp` answers 200
     * and the `.tga` answers 404, so keeping the authored extension is a guaranteed miss followed by a
     * BLP decode of a 404's HTML page, which is the double-misattribution this repo already records.
     *
     * Only the known SOURCE extensions are rewritten. `.blp` is left alone, and anything else keeps its
     * extension rather than being guessed at: a path with an unknown suffix is more likely to be a real
     * name containing a dot than an image this client can find.
     */
    const source = /\.(tga|png|jpg|jpeg|dds)$/i;
    if (source.test(path)) {
      return path.replace(source, '.blp');
    }
    if (!path.includes('.')) {
      return `${path}.blp`;
    }
    return path;
  }

  /**
   * Fetch every registered sprite. Clamped wrapping by default: most glue art is stamped, never
   * tiled, and REPEAT on a sub-rect bleeds neighbouring sprites in along the seams.
   *
   * `def.tile` opts a sprite into REPEAT, for a `Backdrop`'s `bgFile` -- the client authors those
   * with `tile="true"` and a `TileSize`, so they genuinely do repeat. The seam-bleeding hazard above
   * does not apply to them: it is a hazard of REPEAT on a SUB-RECT, and a tiled background samples
   * its whole sheet, so there is no neighbour to bleed in.
   *
   * A sprite that fails to load is logged and left absent -- `texture()` returns null and the
   * renderer skips that quad, so one missing BLP costs one sprite rather than the screen.
   */
  async load(): Promise<void> {
    const generation = this.generation;

    await Promise.all(
      Array.from(this.defs.entries()).map(async ([key, def]) => {
        // An ADOPTED texture has no file behind it; fetching `def.path` would 404 on the key's own
        // name and, worse, the failure branch would drop the live target out of `textures`.
        if (def.external) {
          return;
        }
        const path = this.appendBLP(def.path);
        if (this.textures.has(key)) {
          if (this.loadedFrom.get(key) === path) {
            return;
          }
          // Same key, different art: release what this key held before taking the new reference, or
          // the old texture stays counted in `TextureLoader` with nothing left pointing at it.
          const stale = this.textures.get(key);
          if (stale) {
            TextureLoader.unload(stale);
          }
          this.textures.delete(key);
          this.loadedFrom.delete(key);
        }
        try {
          const wrap = def.tile ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
          const texture = await TextureLoader.load(
            path,
            wrap as any,
            wrap as any,
          );

          if (generation !== this.generation) {
            // Disposed while this fetch was in flight: release the reference `TextureLoader`
            // already counted for us rather than stashing a texture nothing will ever read again.
            TextureLoader.unload(texture);
            return;
          }

          this.textures.set(key, texture);
          this.loadedFrom.set(key, path);
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

  /**
   * Release every texture this table loaded and forget the defs. Goes through the loader's own
   * `unload` (reference-counted) rather than `texture.dispose()` -- some other part of the client
   * (or another `GlueArt` instance) may still hold the same BLP, and disposing it out from under
   * that reference would blank a texture that is still on screen elsewhere.
   *
   * An ADOPTED texture is skipped: `TextureLoader` never counted a reference for it, so unloading it
   * would decrement a count this table never took -- and its real owner (`model-booth.ts`) disposes
   * the render target itself.
   */
  dispose(): void {
    this.generation++;
    this.textures.forEach((texture, key) => {
      if (this.defs.get(key)?.external) {
        return;
      }
      TextureLoader.unload(texture);
    });
    this.textures.clear();
    this.loadedFrom.clear();
    this.defs.clear();
  }
}
