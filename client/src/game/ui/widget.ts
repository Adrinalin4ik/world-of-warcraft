/**
 * The retained glue widget tree.
 *
 * Screens build widgets on mount and MUTATE them; nothing is rebuilt per frame. Art is referenced
 * by sprite KEY and text by string -- resolving either to a GPU resource is the renderer's job, so
 * this file (like `layout.ts` and `hit.ts`) imports no three.js and needs no WebGL to exercise.
 *
 * `drawList` is the single ordered list of what is on screen. Both the renderer and the hit-test
 * consume it, which is what guarantees the thing you click is the thing you see.
 */
import { Anchor, LayoutNode, Rect, resolveAnchors, Viewport } from './layout';

/** Draw layers, back to front -- FrameXML's own ladder plus a DIALOG layer above everything. */
export type Layer = 'BACKGROUND' | 'BORDER' | 'ARTWORK' | 'OVERLAY' | 'HIGHLIGHT' | 'DIALOG';

export const LAYER_ORDER: Layer[] = [
  'BACKGROUND',
  'BORDER',
  'ARTWORK',
  'OVERLAY',
  'HIGHLIGHT',
  'DIALOG',
];

/** Normal alpha, or the ADD blend the glowing glue art is authored for. */
export type Blend = 'ALPHA' | 'ADD';

/** A sub-rectangle of a sprite sheet, as fractions. `v0` is the TOP edge. */
export type TexCoords = { u0: number; v0: number; u1: number; v1: number };

export type WidgetKind =
  | 'frame'
  | 'texture'
  | 'fontstring'
  | 'button'
  | 'editbox'
  | 'checkbutton'
  | 'backdrop';

export type ButtonState = 'up' | 'down' | 'disabled';

export interface FontSpec {
  /** A font family registered by `text.ts` -- e.g. 'FRIZQT', 'MORPHEUS', 'SKURRI'. */
  family: string;
  /** Logical units. */
  size: number;
  color: string;
  /** Draw the client's 1px outline ring. */
  outline: boolean;
  align: 'LEFT' | 'CENTER' | 'RIGHT';
}

let nextWidgetId = 0;

export class Widget {
  readonly id: string;
  readonly kind: WidgetKind;

  parent: Widget | null = null;
  readonly children: Widget[] = [];

  layer: Layer = 'ARTWORK';
  anchors: Anchor[] = [];
  width = 0;
  height = 0;

  shown = true;
  alpha = 1;
  mouseEnabled = false;
  focusable = false;

  /** Sprite key resolved by `GlueArt`; null draws nothing. */
  sprite: string | null = null;
  texCoords: TexCoords | null = null;
  blend: Blend = 'ALPHA';
  /** Multiplied into the sprite, as `#rrggbb`. */
  vertexColor = '#ffffff';

  text = '';
  font: FontSpec | null = null;

  /** Button/checkbutton state. `hovered` is written by the input router. */
  state: ButtonState = 'up';
  hovered = false;
  checked = false;

  /** EditBox state. `text` always holds the real string -- password masking is a DRAW-time-only
   * transform (`screens.ts#resolveSprite`), never applied to the stored value, since that value is
   * what a login screen submits. */
  maxLetters = 0;
  password = false;
  caret = 0;
  /** Selection anchor. Equal to `caret` when there is no selection (the common case). */
  selectionAnchor = 0;

  /**
   * Invoked by a pointer click, and by Enter on a widget that has no `onSubmit` of its own.
   *
   * For a button the two are the same act, so the fallback is correct there. For an EDIT BOX they are
   * not: clicking into a box takes focus (which is what the client does), and it was this field
   * carrying both meanings that made clicking back into the account box to fix a typo submit the typo.
   * A widget where Enter means something a click does not uses `onSubmit`.
   */
  onClick: (() => void) | null = null;
  /**
   * Invoked by Enter, in preference to `onClick`. FrameXML's `OnEnterPressed` -- the login screen's
   * edit boxes submit the form on Enter, and a pointer click on them must not.
   */
  onSubmit: (() => void) | null = null;
  /** Invoked by Escape; if absent, Escape does nothing (no fallback to onClick). */
  onCancel: (() => void) | null = null;

  constructor(kind: WidgetKind, id?: string) {
    this.kind = kind;
    this.id = id ?? `${kind}-${nextWidgetId++}`;
  }

  add(child: Widget): Widget {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(child: Widget): void {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parent = null;
    }
  }

  setAnchors(...anchors: Anchor[]): Widget {
    this.anchors = anchors;
    return this;
  }

  setSize(width: number, height: number): Widget {
    this.width = width;
    this.height = height;
    return this;
  }

  show(): void {
    this.shown = true;
  }

  hide(): void {
    this.shown = false;
  }

  /** Shown only if every ancestor is too. */
  get visible(): boolean {
    let node: Widget | null = this;
    while (node) {
      if (!node.shown) {
        return false;
      }
      node = node.parent;
    }
    return true;
  }

  /**
   * What an edit box SHOWS, as opposed to what it holds. `text` is always the real string -- a
   * login screen submits it -- so masking lives here, at the one place every consumer (a mirrored
   * FontString today; the renderer directly, if a future screen draws an editbox's text itself)
   * should read from instead of `text` when putting glyphs on screen.
   */
  get displayText(): string {
    if (this.kind === 'editbox' && this.password) {
      return '•'.repeat(this.text.length);
    }
    return this.text;
  }
}

export interface DrawItem {
  widget: Widget;
  rect: Rect;
  /** The widget's alpha multiplied down the ancestor chain. */
  alpha: number;
}

export class WidgetRoot {
  readonly root = new Widget('frame', 'root');

  constructor() {
    // The root always fills the window, so a child with no anchors still resolves.
    this.root.setAnchors(
      { point: 'TOPLEFT', x: 0, y: 0 },
      { point: 'BOTTOMRIGHT', x: 0, y: 0 },
    );
  }

  /**
   * Flatten to a back-to-front draw list with resolved rects.
   *
   * Order is layer first, then depth-first insertion order within a layer -- so a child in
   * OVERLAY draws above an unrelated parent's HIGHLIGHT only if the layer says so, never because of
   * where it sits in the tree. Hidden subtrees are skipped whole.
   */
  drawList(viewport: Viewport): DrawItem[] {
    const flat: Array<{ widget: Widget; alpha: number; sequence: number }> = [];
    const nodes: LayoutNode[] = [];
    let sequence = 0;

    const walk = (widget: Widget, alpha: number): void => {
      if (!widget.shown) {
        return;
      }

      const cumulative = alpha * widget.alpha;
      flat.push({ widget, alpha: cumulative, sequence: sequence++ });
      nodes.push({
        id: widget.id,
        width: widget.width,
        height: widget.height,
        anchors: widget.anchors,
      });

      for (const child of widget.children) {
        walk(child, cumulative);
      }
    };

    walk(this.root, 1);

    const rects = resolveAnchors(nodes, viewport);

    return flat
      .sort((a, b) => {
        const layers = LAYER_ORDER.indexOf(a.widget.layer) - LAYER_ORDER.indexOf(b.widget.layer);
        return layers !== 0 ? layers : a.sequence - b.sequence;
      })
      .map((entry) => ({
        widget: entry.widget,
        rect: rects.get(entry.widget.id)!,
        alpha: entry.alpha,
      }));
  }
}
