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
// Type-only, and it has to stay that way: `backdrop.ts` imports `TexCoords` from here, so a value
// import in either direction would close a runtime cycle. `isolatedModules` guarantees babel elides
// this one.
import type { BackdropDef } from './backdrop';
import { Anchor, LayoutNode, Rect, resolveAnchors, Viewport } from './layout';
import { DrawLayer, OrderKey, Strata, compareOrder } from './framexml/order';

/** The five FrameXML draw layers. DIALOG is NOT here -- it is a `Strata`; see `framexml/order.ts`. */
export type Layer = DrawLayer;
export type { Strata };

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
  /**
   * Wrap at this width, in logical units -- a FontString's authored `Size` x when the client lets it
   * wrap (`GlueDialogText` is 450 wide, gluedialog.xml). OPT-IN: absent means the string is measured
   * and rasterized as one line exactly as it always was, so no existing caption's metrics move.
   */
  wrapWidth?: number;
  /**
   * Extra leading between wrapped lines, in logical units -- a `Font`'s `spacing` attribute
   * (`GlueFontNormalLarge` sets `spacing="2"`, gluefontstyles.xml:97). Only reachable through
   * `wrapWidth`, since a single line has no gap to space.
   */
  spacing?: number;
}

let nextWidgetId = 0;

export class Widget {
  readonly id: string;
  readonly kind: WidgetKind;

  parent: Widget | null = null;
  readonly children: Widget[] = [];

  layer: Layer = 'ARTWORK';
  /** Frame strata -- a higher-ranked axis than `layer`. Inherited from the parent on `add`. */
  strata: Strata = 'MEDIUM';
  /** Born at the parent's level + 1; see `framexml/order.ts` for why the tie matters. */
  frameLevel = 0;
  /** The widget's DFS index -- see `orderKey` below for why this is a stand-in. */
  linkStamp = 0;
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
  /**
   * A FrameXML `Backdrop`, for the `backdrop` kind: the renderer draws it as the nine pieces
   * `backdrop.ts` computes rather than as one stretched quad. Sprite KEYS, not paths -- the paths
   * stay in the art table.
   */
  backdrop: BackdropDef | null = null;
  /**
   * Draw a flat `vertexColor` quad with no art at all.
   *
   * OURS, not the client's: this exists for the edit-box caret, which the real client's engine draws
   * with no XML to transcribe. Nothing else should need it -- every other quad on a glue screen is
   * authored art.
   */
  solid = false;
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
  /**
   * FrameXML's `OnDoubleClick`, fired IN ADDITION to the second `onClick` -- which is what the
   * engine does, and what `RealmListRealmButtonTemplate` relies on: its `OnClick` selects a realm
   * and its `OnDoubleClick` joins the one just selected (realmlist.xml:234-239).
   */
  onDoubleClick: (() => void) | null = null;

  constructor(kind: WidgetKind, id?: string) {
    this.kind = kind;
    this.id = id ?? `${kind}-${nextWidgetId++}`;
  }

  add(child: Widget): Widget {
    child.parent = this;
    child.strata = this.strata;
    child.frameLevel = this.frameLevel + 1;
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

/**
 * `linkStamp` is the widget's DFS index -- a STAND-IN for the client's live list position, which is
 * re-stamped to the bucket tail when a frame is shown or its strata/level changes. Static DFS order
 * is right for a screen built once and never re-shown, which is every screen today. `Show` and
 * `SetFrameLevel` make it live in plan 2; until then, do not read this as the client's rule.
 */
const orderKey = (entry: { widget: Widget; sequence: number }): OrderKey => ({
  strata: entry.widget.strata,
  frameLevel: entry.widget.frameLevel,
  layer: entry.widget.layer,
  isFontString: entry.widget.kind === 'fontstring',
  linkStamp: entry.sequence,
  declarationSeq: 0,
});

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
   * Order is the client's real key -- strata, then frame level, then draw layer, then textures
   * before font strings, then insertion order -- NOT a simple "walk the tree" order. See
   * `framexml/order.ts` for why the layer outranks the frame and why font strings sort last.
   * Hidden subtrees are skipped whole.
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
      .sort((a, b) => compareOrder(orderKey(a), orderKey(b)))
      .map((entry) => ({
        widget: entry.widget,
        rect: rects.get(entry.widget.id)!,
        alpha: entry.alpha,
      }));
  }
}
