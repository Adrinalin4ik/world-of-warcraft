/**
 * Glue layout: authored units, the virtual-screen scale law, and FrameXML anchor resolution.
 *
 * Deliberately free of three.js. Everything here is arithmetic over plain objects so it can be
 * tested in jsdom -- the renderer is the only file that turns these rects into meshes.
 *
 * Coordinates: logical units matching the authored GlueXML values, with `top` measured DOWNWARD
 * from the top of the window (screen convention). Anchor OFFSETS keep FrameXML's convention
 * instead: `+y` is UP. The two meet in `pointOf`/`placeFromAnchor` below and nowhere else.
 */

/** The height the reference authors every glue screen against. */
export const AUTHORED_HEIGHT = 768;

/**
 * The upper clamp on the virtual-screen scale: the shipped size on a tall display. There is
 * deliberately NO lower clamp -- see `screenScale`.
 */
export const MAX_SCALE = 2.2;

export type AnchorPoint =
  | 'TOPLEFT' | 'TOP' | 'TOPRIGHT'
  | 'LEFT' | 'CENTER' | 'RIGHT'
  | 'BOTTOMLEFT' | 'BOTTOM' | 'BOTTOMRIGHT';

export interface Anchor {
  /** The point ON THIS NODE being placed. */
  point: AnchorPoint;
  /** Id of the node to anchor against; the window when absent. */
  relativeTo?: string;
  /** The point on the relative node; mirrors `point` when absent. */
  relativePoint?: AnchorPoint;
  /** Offset in logical units. `+x` right, `+y` UP (FrameXML). */
  x: number;
  y: number;
}

/** Logical units, `top` measured downward from the window's top edge. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LayoutNode {
  id: string;
  /** Ignored on an axis constrained by two opposing anchors. */
  width: number;
  height: number;
  anchors: Anchor[];
}

/** The window in device pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * The virtual-screen scale: authored units to device pixels.
 *
 * The reference lays each glue screen out on a 768-unit-tall virtual screen and scales it by the
 * window height. The upper clamp is the shipped size on a tall screen. **Adding a lower clamp is a
 * bug**: it draws the full-height layout into a shorter window, and the overflow silently falls off
 * the bottom -- always the bottom-most controls (benilla lost the last customization row and the
 * RANDOMIZE button this way at 1276x677).
 */
export function screenScale(viewportHeight: number): number {
  return Math.min(viewportHeight / AUTHORED_HEIGHT, MAX_SCALE);
}

/**
 * The window expressed in logical units. Height is ~768 (exactly 768 below the clamp); width grows
 * with the window's aspect, so a widescreen window shows MORE WIDTH rather than letterboxing.
 */
export function viewportUnits(viewport: Viewport): { width: number; height: number; scale: number } {
  const scale = screenScale(viewport.height);
  return { width: viewport.width / scale, height: viewport.height / scale, scale };
}

const HORIZONTAL: Record<AnchorPoint, number> = {
  TOPLEFT: 0, LEFT: 0, BOTTOMLEFT: 0,
  TOP: 0.5, CENTER: 0.5, BOTTOM: 0.5,
  TOPRIGHT: 1, RIGHT: 1, BOTTOMRIGHT: 1,
};

const VERTICAL: Record<AnchorPoint, number> = {
  TOPLEFT: 0, TOP: 0, TOPRIGHT: 0,
  LEFT: 0.5, CENTER: 0.5, RIGHT: 0.5,
  BOTTOMLEFT: 1, BOTTOM: 1, BOTTOMRIGHT: 1,
};

/** The absolute position of one point on a rect. */
function pointOf(rect: Rect, point: AnchorPoint): { x: number; y: number } {
  return {
    x: rect.left + rect.width * HORIZONTAL[point],
    y: rect.top + rect.height * VERTICAL[point],
  };
}

function resolveOne(node: LayoutNode, resolved: Map<string, Rect>, screen: Rect): Rect {
  // Edge constraints gathered from the anchors. An axis with two of them SIZES the node.
  let left: number | null = null;
  let right: number | null = null;
  let top: number | null = null;
  let bottom: number | null = null;

  for (const anchor of node.anchors) {
    const relative = anchor.relativeTo ? resolved.get(anchor.relativeTo) : screen;
    if (!relative) {
      throw new Error(`anchor of "${node.id}" references unresolved node "${anchor.relativeTo}"`);
    }

    const target = pointOf(relative, anchor.relativePoint ?? anchor.point);
    // FrameXML's `+y` is up; our `top` grows downward, hence the subtraction.
    const x = target.x + anchor.x;
    const y = target.y - anchor.y;

    const h = HORIZONTAL[anchor.point];
    if (h === 0) {
      left = x;
    } else if (h === 1) {
      right = x;
    } else {
      left = x - node.width / 2;
    }

    const v = VERTICAL[anchor.point];
    if (v === 0) {
      top = y;
    } else if (v === 1) {
      bottom = y;
    } else {
      top = y - node.height / 2;
    }
  }

  const width = left !== null && right !== null ? right - left : node.width;
  const height = top !== null && bottom !== null ? bottom - top : node.height;

  return {
    left: left !== null ? left : right !== null ? right - width : 0,
    top: top !== null ? top : bottom !== null ? bottom - height : 0,
    width,
    height,
  };
}

/**
 * Resolve every node's rect. Nodes may anchor to each other in any input order; a cycle throws
 * rather than spinning.
 */
export function resolveAnchors(nodes: LayoutNode[], viewport: Viewport): Map<string, Rect> {
  const units = viewportUnits(viewport);
  const screen: Rect = { left: 0, top: 0, width: units.width, height: units.height };

  const resolved = new Map<string, Rect>();
  let pending = nodes.slice();

  while (pending.length > 0) {
    const ready = pending.filter((node) =>
      node.anchors.every((anchor) => !anchor.relativeTo || resolved.has(anchor.relativeTo)),
    );

    if (ready.length === 0) {
      throw new Error(
        `anchor cycle among: ${pending.map((node) => node.id).join(', ')}`,
      );
    }

    for (const node of ready) {
      resolved.set(node.id, resolveOne(node, resolved, screen));
    }

    pending = pending.filter((node) => !resolved.has(node.id));
  }

  return resolved;
}
