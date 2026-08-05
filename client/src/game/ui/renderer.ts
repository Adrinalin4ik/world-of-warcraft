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

import { viewportUnits } from './layout';
import { applyTexCoords, createQuadMaterial } from './material';
import { DrawItem } from './widget';

/**
 * What resolving a widget's texture hands back. `size` is set for a font string only -- its
 * logical (layout-unit) rasterized size, from `FontStringTextures#get`. An art quad has none: it
 * always fills its widget's authored rect, as it always has.
 */
export type ResolvedSprite = { texture: THREE.Texture; size?: { width: number; height: number } };
export type SpriteResolver = (item: DrawItem) => ResolvedSprite | null;

/** One unit quad, shared by every widget. Sub-rects come from the material's map offset/repeat. */
const QUAD = new THREE.PlaneGeometry(1, 1);

type Pooled = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
};

export class GlueRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000);
  private readonly pool = new Map<string, Pooled>();

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

    items.forEach((item, index) => {
      const resolved = resolve(item);
      if (!resolved) {
        return;
      }
      const { texture, size } = resolved;

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
      applyTexCoords(entry.material, item.widget.texCoords);

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

      // Draw order, not depth: depth testing is off and every quad sits at z = 0.
      entry.mesh.renderOrder = index;
      entry.mesh.visible = true;
    });

    // A widget that vanished this frame keeps its pooled mesh (screens re-show things constantly)
    // but must not draw.
    this.pool.forEach((entry, id) => {
      if (!live.has(id)) {
        entry.mesh.visible = false;
      }
    });

    const previousAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = previousAutoClear;
  }

  dispose(): void {
    this.pool.forEach((entry) => {
      this.scene.remove(entry.mesh);
      entry.material.dispose();
    });
    this.pool.clear();
  }
}
