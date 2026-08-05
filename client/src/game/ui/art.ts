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
   * Glue art paths are conventionally extensionless, as declared in the game's GlueXML.
   * The engine supplies `.blp` at load time. This helper appends it when absent, leaving
   * paths that already carry an extension untouched (some client data does specify `.blp`
   * explicitly, and future tables may as well).
   */
  private appendBLP(path: string): string {
    if (!path.includes('.')) {
      return `${path}.blp`;
    }
    return path;
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
            this.appendBLP(def.path),
            THREE.ClampToEdgeWrapping as any,
            THREE.ClampToEdgeWrapping as any,
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
