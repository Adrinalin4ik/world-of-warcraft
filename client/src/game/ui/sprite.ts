/**
 * A draw-list item to the texture that draws it.
 *
 * This was `GlueApp#resolveSprite`, private to `screens.ts`. It is a module now because the WORLD ui
 * host (`world-ui.ts`) resolves exactly the same four cases against exactly the same art table and
 * font cache, and two copies of these rules would drift silently -- the backdrop case in particular,
 * whose comment records a defect that cost a whole screen's borders.
 *
 * Nothing here is glue- or world-specific: it is the widget layer's own rule for what a widget's
 * pixels come from.
 */
import * as THREE from 'three';

import { GlueArt } from './art';
import { ResolvedSprite } from './renderer';
import { FontStringTextures } from './text';
import { DrawItem } from './widget';

/** What `resolveSprite` needs from its host, so it needs no host. */
export interface SpriteSources {
  art: GlueArt;
  fonts: FontStringTextures;
  /** A 1x1 white texel for a `solid` widget (the edit-box caret). Lazily made and owned by the host. */
  solid(): THREE.Texture;
}

/** A widget's texture: a font string rasterizes, everything else comes from the art table. */
export function resolveSprite(
  item: DrawItem,
  scale: number,
  sources: SpriteSources,
): ResolvedSprite | null {
  const widget = item.widget;

  if (widget.kind === 'fontstring') {
    // `displayText`, not `text`: password masking (`Widget#displayText`) lives here, at the one
    // place a fontstring's content actually turns into glyphs.
    return widget.font ? sources.fonts.get(widget.displayText, widget.font, scale) : null;
  }

  // A flat colour quad -- the caret. `vertexColor` does the colouring; the texel is just a carrier.
  if (widget.solid) {
    return { texture: sources.solid() };
  }

  // A `Backdrop` carries two sheets and is drawn as nine pieces by the renderer, so it resolves
  // both rather than one `sprite`.
  //
  // Keyed off the DEF, never off `kind`. In FrameXML a `Backdrop` is a PROPERTY of a frame, and a
  // frame of any type may carry one -- the login screen's are on three `EditBox`es and one `Frame`.
  // Gating this on `kind === 'backdrop'` meant all three edit boxes (kind `editbox`, carrying a
  // Backdrop) fell through to the sprite path, where their `sprite` is null, so this returned null
  // and the renderer skipped the widget: no border on screen and no warning anywhere, because
  // nothing had failed to load. The `backdrop` WidgetKind is only "a frame that is nothing BUT its
  // Backdrop" (the dialog); it is not what selects this path.
  if (widget.backdrop) {
    const def = widget.backdrop;
    const background = def.bgSprite ? sources.art.texture(def.bgSprite) : null;
    const edge = def.edgeSprite ? sources.art.texture(def.edgeSprite) : null;
    if (!background && !edge) {
      return null;
    }
    return { backdrop: { background, edge } };
  }

  const texture = widget.sprite ? sources.art.texture(widget.sprite) : null;
  if (!texture) {
    return null;
  }

  // The sub-rect travels with the SPRITE, not the widget: `GlueButtonTemplateBlue` names one
  // region of `Glue-Panel-Button-Up-Blue` for every button that inherits it, so the art table is
  // where it belongs. Without this the whole 256x64 sheet stretched into the widget's rect and
  // every glue button drew as a thin bar of blue with two thirds of the quad empty.
  return { texture, texCoords: sources.art.def(widget.sprite as string)?.texCoords ?? null };
}
