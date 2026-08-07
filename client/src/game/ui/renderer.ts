/**
 * The UI render pass: one orthographic scene of textured quads, drawn over whatever the renderer
 * already has in the buffer.
 *
 * The widget layer never OWNS a renderer. It is handed one -- the glue host's now, the game's when
 * the in-world HUD is built on this same layer -- and draws with `autoClear = false` so the 3D glue
 * scene beneath it survives.
 *
 * Meshes are pooled per widget id: a glue screen mutates its tree, it does not rebuild it, so
 * allocating a quad per frame would be pure garbage.
 */
import * as THREE from 'three';

import { BackdropPiece, backdropPieces } from './backdrop';
import { viewportUnits } from './layout';
import { applyTexCoords, createQuadMaterial } from './material';
import { DrawItem, TexCoords } from './widget';

/** A `Backdrop`'s two resolved sheets, plus the def whose geometry they are drawn with. */
export type ResolvedBackdrop = {
  background: THREE.Texture | null;
  edge: THREE.Texture | null;
};

/**
 * What resolving a widget's texture hands back. `size` is set for a font string only -- its
 * logical (layout-unit) rasterized size, from `FontStringTextures#get`. An art quad has none: it
 * always fills its widget's authored rect, as it always has.
 */
export type ResolvedSprite = {
  /** Absent for a backdrop, which carries its own two sheets in `backdrop` instead. */
  texture?: THREE.Texture;
  size?: { width: number; height: number };
  /** The sprite's own sub-rect, from the art table. A widget's own `texCoords` overrides it. */
  texCoords?: TexCoords | null;
  /** Set instead of `texture` for a `backdrop` widget. */
  backdrop?: ResolvedBackdrop;
};
export type SpriteResolver = (item: DrawItem) => ResolvedSprite | null;

/** One unit quad, shared by every plain widget. Sub-rects come from the material's map offset/repeat. */
const QUAD = new THREE.PlaneGeometry(1, 1);

/**
 * Render-order slots per draw-list entry. A backdrop spends up to nine of them on its own pieces, so
 * every widget's slot is multiplied by this to leave room without disturbing widget-to-widget order.
 */
const ORDER_STRIDE = 16;

type Pooled = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
};

/**
 * One drawn piece of a backdrop. Each carries its OWN geometry, and that is the whole point.
 *
 * `applyTexCoords` puts a sub-rect on the material's map by setting `offset`/`repeat` on the
 * THREE.Texture -- which is SHARED across every widget sampling that sheet. Nine pieces of one
 * border atlas need nine different sub-rects in a single frame, so going through the shared texture
 * would leave whichever piece was applied last sampling for all nine (the hazard the note at the
 * `applyTexCoords` call site below warns about).
 *
 * So the sub-rects live in the geometry's `uv` attribute instead, one geometry per piece. This is
 * strictly better than cloning the texture per sub-rect, for two reasons:
 *
 *  - It is the only option that WORKS. The TOP and BOTTOM tiles are stored rotated (see
 *    `backdrop.ts`), so those two pieces need u and v SWAPPED. `offset`/`repeat` scale and translate
 *    the two axes independently and cannot swap them, so no amount of per-piece texture cloning
 *    draws a correct top edge.
 *  - It adds no second texture lifecycle. A clone shares its original's `source` but is its own
 *    disposable object, on top of the reference count `TextureLoader`/`GlueArt` already keep -- two
 *    schemes for one image. Geometry is owned outright by this pool and disposed with it.
 *
 * The shared texture's own `offset`/`repeat` are still reset to identity before a backdrop draws,
 * so a stale sub-rect left on the sheet by some future widget cannot shift a backdrop. That reset is
 * conflict-free where `applyTexCoords` was not: all nine pieces want the same identity transform.
 */
type PooledPiece = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  geometry: THREE.BufferGeometry;
};

type PooledBackdrop = {
  pieces: PooledPiece[];
};

/**
 * Write a piece's sub-rect into its geometry's `uv` attribute.
 *
 * `PlaneGeometry(1, 1)` emits four vertices in the order left-bottom, right-bottom, left-top,
 * right-top -- "bottom" being local +y, which the Y-DOWN camera puts at the BOTTOM of the screen
 * (`material.ts`). `v = 0` is the sheet's top row (textures load `flipY = false`), so `v0` is the
 * top edge, matching `TexCoords`.
 */
function writePieceUVs(geometry: THREE.BufferGeometry, piece: BackdropPiece): void {
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const tc = piece.texCoords;
  const repeat = piece.repeat;

  // (fx, fy) per vertex: fx = 0 at the left edge, fy = 0 at the TOP edge.
  const corners: Array<[number, number]> = [
    [0, 1],
    [1, 1],
    [0, 0],
    [1, 0],
  ];

  corners.forEach(([fx, fy], index) => {
    let u: number;
    let v: number;
    if (repeat) {
      // The tiled background: the whole sheet, repeated. UVs run past 1, which is what makes the
      // texture's REPEAT wrapping (requested per-sprite by `GlueArt`) tile it instead of stretch it.
      u = fx * repeat.x;
      v = fy * repeat.y;
    } else if (!tc) {
      u = fx;
      v = fy;
    } else if (piece.transposed) {
      // TOP/BOTTOM: the tile is stored as a vertical strip, so the drawn ROW selects u and the drawn
      // COLUMN selects v. No mirror -- `backdrop.ts` records how that direction was measured.
      u = tc.u0 + fy * (tc.u1 - tc.u0);
      v = tc.v0 + fx * (tc.v1 - tc.v0);
    } else {
      u = tc.u0 + fx * (tc.u1 - tc.u0);
      v = tc.v0 + fy * (tc.v1 - tc.v0);
    }
    uv.setXY(index, u, v);
  });

  uv.needsUpdate = true;
}

export class GlueRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000);
  private readonly pool = new Map<string, Pooled>();
  /** Backdrop widgets pool separately: one entry holds up to nine meshes rather than one. */
  private readonly backdropPool = new Map<string, PooledBackdrop>();

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.scene.name = 'GlueUI';
  }

  render(items: DrawItem[], resolve: SpriteResolver): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    const units = viewportUnits({ width: size.x, height: size.y });

    // Y-DOWN: top = 0, bottom = height. Logical units, so widget rects map 1:1.
    this.camera.left = 0;
    this.camera.right = units.width;
    this.camera.top = 0;
    this.camera.bottom = units.height;
    this.camera.updateProjectionMatrix();

    const live = new Set<string>();
    const liveBackdrops = new Set<string>();

    items.forEach((item, index) => {
      const resolved = resolve(item);
      if (!resolved) {
        return;
      }

      // A backdrop is nine pieces of two sheets, not one stretched quad.
      if (resolved.backdrop && item.widget.backdrop) {
        liveBackdrops.add(item.widget.id);
        this.renderBackdrop(item, index, resolved.backdrop);
        return;
      }

      const { texture, size } = resolved;
      if (!texture) {
        return;
      }

      live.add(item.widget.id);

      let entry = this.pool.get(item.widget.id);
      if (!entry) {
        const material = createQuadMaterial(item.widget.blend);
        const mesh = new THREE.Mesh(QUAD, material);
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        entry = { mesh, material };
        this.pool.set(item.widget.id, entry);
      }

      entry.material.map = texture;
      entry.material.blending =
        item.widget.blend === 'ADD' ? THREE.AdditiveBlending : THREE.NormalBlending;
      entry.material.opacity = item.alpha;
      entry.material.color.set(item.widget.vertexColor);
      entry.material.needsUpdate = true;
      // The widget's own sub-rect wins when it sets one; otherwise the sprite's, from the art table.
      // NOTE: offset/repeat live on the shared THREE.Texture, so two widgets sampling DIFFERENT
      // regions of one sheet in the same frame would both draw with whichever was applied last. No
      // glue screen does that yet -- every sprite sharing a sheet shares its region too.
      applyTexCoords(entry.material, item.widget.texCoords ?? resolved.texCoords ?? null);

      const { left, top, width, height } = item.rect;

      if (size) {
        // A font string draws at its rasterized size, not stretched to the widget's rect: text.ts
        // sizes the canvas to the glyphs' actual extent, so a fixed-size quad would squash or
        // stretch every letter. Position within the rect by the font's horizontal alignment and
        // always vertically centred -- there is no vertical-align concept in GlueXML fontstrings.
        const align = item.widget.font?.align ?? 'LEFT';
        const quadLeft =
          align === 'CENTER'
            ? left + (width - size.width) / 2
            : align === 'RIGHT'
              ? left + width - size.width
              : left;
        const quadTop = top + (height - size.height) / 2;
        entry.mesh.position.set(quadLeft + size.width / 2, quadTop + size.height / 2, 0);
        entry.mesh.scale.set(size.width, size.height, 1);
      } else {
        entry.mesh.position.set(left + width / 2, top + height / 2, 0);
        entry.mesh.scale.set(width, height, 1);
      }

      // Draw order, not depth: depth testing is off and every quad sits at z = 0. Strided so a
      // backdrop's nine pieces have slots of their own between one widget and the next.
      entry.mesh.renderOrder = index * ORDER_STRIDE;
      entry.mesh.visible = true;
    });

    // A widget that vanished this frame keeps its pooled mesh (screens re-show things constantly)
    // but must not draw.
    this.pool.forEach((entry, id) => {
      if (!live.has(id)) {
        entry.mesh.visible = false;
      }
    });
    this.backdropPool.forEach((entry, id) => {
      if (!liveBackdrops.has(id)) {
        entry.pieces.forEach((piece) => (piece.mesh.visible = false));
      }
    });

    const previousAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = previousAutoClear;
  }

  /**
   * Draw one `backdrop` widget as the nine pieces `backdropPieces` computes.
   *
   * Meshes are pooled per widget id and GROWN as needed, never rebuilt: the count only changes when
   * a rect gets too small for an edge run, and a dialog resized to its text does that. Pieces beyond
   * this frame's count are hidden rather than freed, so a dialog that shrinks and grows again does
   * not churn geometry.
   */
  private renderBackdrop(item: DrawItem, index: number, resolved: ResolvedBackdrop): void {
    const def = item.widget.backdrop!;
    const pieces = backdropPieces(item.rect, def);

    let entry = this.backdropPool.get(item.widget.id);
    if (!entry) {
      entry = { pieces: [] };
      this.backdropPool.set(item.widget.id, entry);
    }

    // Both sheets draw with an identity uv transform -- the sub-rects are in the geometry. Resetting
    // it here is what keeps a stale `applyTexCoords` from another widget off a backdrop's sheets.
    [resolved.background, resolved.edge].forEach((texture) => {
      if (texture) {
        texture.offset.set(0, 0);
        texture.repeat.set(1, 1);
      }
    });

    pieces.forEach((piece, ordinal) => {
      const texture = piece.sprite === 'bg' ? resolved.background : resolved.edge;
      if (!texture) {
        return;
      }

      let pooled = entry!.pieces[ordinal];
      if (!pooled) {
        const geometry = QUAD.clone();
        const material = createQuadMaterial(item.widget.blend);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        pooled = { mesh, material, geometry };
        entry!.pieces[ordinal] = pooled;
      }

      pooled.material.map = texture;
      pooled.material.blending =
        item.widget.blend === 'ADD' ? THREE.AdditiveBlending : THREE.NormalBlending;
      // The backdrop's own tint MULTIPLIES the widget's, exactly as the engine's
      // `SetBackdropColor`/`SetBackdropBorderColor` do: they darken the sheet rather than replacing
      // it, so `Glue-Tooltip-Background` at (0.09, 0.09, 0.09, 0.85) is a dark translucent pane and
      // not a flat fill. Background and edge carry different tints, which is the whole reason a
      // per-piece colour is needed and a per-widget `vertexColor` cannot express this.
      //
      // The channel-wise multiply is exact rather than approximate because `src/index.tsx` sets
      // `THREE.ColorManagement.enabled = false`: `Color#set` stores the authored sRGB values
      // untouched, so there is no working-space conversion for the tint to be applied on the wrong
      // side of.
      pooled.material.opacity = item.alpha * piece.tint.a;
      pooled.material.color.set(item.widget.vertexColor);
      pooled.material.color.r *= piece.tint.r;
      pooled.material.color.g *= piece.tint.g;
      pooled.material.color.b *= piece.tint.b;
      pooled.material.needsUpdate = true;

      writePieceUVs(pooled.geometry, piece);

      const { left, top, width, height } = piece.rect;
      pooled.mesh.position.set(left + width / 2, top + height / 2, 0);
      pooled.mesh.scale.set(width, height, 1);
      pooled.mesh.renderOrder = index * ORDER_STRIDE + ordinal;
      pooled.mesh.visible = true;
    });

    // Slots this frame did not fill (a rect that lost an edge run) must not keep drawing.
    for (let ordinal = pieces.length; ordinal < entry.pieces.length; ordinal += 1) {
      entry.pieces[ordinal].mesh.visible = false;
    }
  }

  dispose(): void {
    this.pool.forEach((entry) => {
      this.scene.remove(entry.mesh);
      entry.material.dispose();
    });
    this.pool.clear();
    // The per-piece geometries are this pool's own -- nothing else references them -- so they are
    // disposed here alongside the materials. The two SHEETS are not: they belong to `GlueArt`'s
    // reference count, which is exactly why this renderer clones geometry and never textures.
    this.backdropPool.forEach((entry) => {
      entry.pieces.forEach((piece) => {
        this.scene.remove(piece.mesh);
        piece.material.dispose();
        piece.geometry.dispose();
      });
    });
    this.backdropPool.clear();
  }
}
