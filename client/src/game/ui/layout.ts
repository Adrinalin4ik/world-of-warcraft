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

/**
 * Every anchor point constrains BOTH axes, and on one of them it may only pin the CENTRE: `LEFT`
 * fixes the left edge but says nothing about the top -- only that the node's vertical midpoint sits
 * on the target's. So the two kinds of constraint are gathered separately and an EDGE always beats a
 * CENTRE, whatever order the anchors were authored in.
 *
 * That precedence is not a tie-break of convenience; it is the only reading that renders the
 * client's own documents. `CharSelectRealmName` (characterselect.xml:437) declares three anchors --
 * `TOP` at y=-10, then `LEFT` at x=8, then `RIGHT` at x=-8 -- meaning "span the panel's width, ten
 * units below its top". Letting the later `LEFT`/`RIGHT` write a centre-derived `top` puts the realm
 * name (and `CharSelectChangeRealmButton`, which anchors beneath it) halfway down a 642-unit panel
 * instead of at its head, which is exactly what this screen did before.
 */
function resolveOne(node: LayoutNode, resolved: Map<string, Rect>, screen: Rect): Rect {
  // Edge constraints gathered from the anchors. An axis with two of them SIZES the node.
  let left: number | null = null;
  let right: number | null = null;
  let top: number | null = null;
  let bottom: number | null = null;
  // Centre constraints, used only on an axis no edge constrained.
  let centerX: number | null = null;
  let centerY: number | null = null;

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
      centerX = x;
    }

    const v = VERTICAL[anchor.point];
    if (v === 0) {
      top = y;
    } else if (v === 1) {
      bottom = y;
    } else {
      centerY = y;
    }
  }

  if (left === null && right === null && centerX !== null) {
    left = centerX - node.width / 2;
  }
  if (top === null && bottom === null && centerY !== null) {
    top = centerY - node.height / 2;
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
 * The nodes the client's own resolver would not place at all: **a LayoutFrame with no anchor points
 * has no rect**, and neither has anything anchored to one.
 *
 * This is the client's rule, not a policy choice. `samples/benilla/crates/benilla-ui/src/layout.rs`
 * is a bit-exact transcription of `CLayoutFrame`'s geometry resolver, and it states both halves as
 * tests: `no_anchor_is_unresolvable` (layout.rs:1254 -- "a frame with no SetPoint cannot resolve;
 * every edge derives circularly to +Inf") and `dependent_of_unresolvable_is_unresolvable`
 * (layout.rs:1282, which asserts `rect(A).is_none()` AND `rect(B).is_none()`). The engine's UNSET
 * sentinel is `+Infinity` and `assemble` fails the whole rect if any edge is still UNSET
 * (layout.rs:39, 654).
 *
 * `resolveOne` below instead gives an unanchored node `left = 0, top = 0` -- the WINDOW's top-left
 * corner. That single divergence is what put the client's own unanchored frames in a heap in the
 * corner of the world screen: `QuestInfoRequiredMoneyFrame` (questinfo.xml:213, a `<Frame>` with a
 * `<Size>` and no `<Anchors>`, whose whole point is that `QuestInfo_Display` anchors it into the
 * quest frame when a quest is shown) drew its gold/silver/copper coins over the sky, and
 * `ChatChannelDropDown` and `ChatBNPlayerDropDown` (chatframe.xml:172-173, `UIDropDownMenuTemplate`
 * with no anchors -- `ToggleDropDownMenu` positions them when a menu opens) drew a whole dropdown
 * control there. 32 of the 41 unanchored widgets in the live tree were of that shape.
 *
 * The propagation is the second half and it is not optional: `QuestInfoRequiredMoneyDisplay` anchors
 * LEFT to a font string INSIDE the unplaceable frame, so dropping the frame alone would leave the
 * coins behind, resolved through the "anchored to something not being drawn" fallback -- in the same
 * corner.
 *
 * DELIBERATELY NARROW. A node whose `relativeTo` is not in this node set at all is NOT touched: that
 * is the hidden-target case `resolveAnchors` reports and places leniently, it is load-bearing on the
 * character-select screen (`CharSelectChangeRealmButton` -> a font string `CharacterSelect_OnShow`
 * hides), and the client's answer there is a separate question from this one.
 */
export function unplaceableNodes(nodes: LayoutNode[]): Set<string> {
  const unplaceable = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    if (node.anchors.length === 0) {
      unplaceable.add(node.id);
    }
  }

  // Fixpoint rather than one pass: a chain of three frames each anchored to the last needs as many
  // passes as it is long, and the tree is not in dependency order.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (unplaceable.has(node.id)) {
        continue;
      }
      const doomed = node.anchors.some(
        (anchor) =>
          anchor.relativeTo !== undefined &&
          byId.has(anchor.relativeTo) &&
          unplaceable.has(anchor.relativeTo),
      );
      if (doomed) {
        unplaceable.add(node.id);
        changed = true;
      }
    }
  }

  return unplaceable;
}

/** Layout complaints already reported, so a per-frame one is a single console line. */
const warned = new Set<string>();

/**
 * Resolve every node's rect. Nodes may anchor to each other in any input order.
 *
 * ONE BAD SUBTREE MUST NOT COST THE SCREEN. A node whose anchor can never resolve -- a genuine cycle,
 * or a `relativeTo` that is not in this node set at all -- used to make this THROW, and the caller is
 * `WidgetRoot#drawList` inside `GlueApp#tick`, so the whole 2D interface disappeared every frame while
 * the 3D stage behind it kept drawing. That is the same structural failure `GlueApp#tick` already
 * guards the stage pass for, and it is not hypothetical either: `CharSelectChangeRealmButton` anchors
 * TOP to `CharSelectRealmName` (characterselect.xml:467), `CharacterSelect_OnShow` HIDES that font
 * string when the engine has no server name (characterselect.lua:73), and `drawList` puts no node in
 * this set for a hidden widget -- so one legitimately hidden region blanked all 85 shown ones.
 *
 * So the unresolvable nodes are placed by whatever anchors they DO have (none of them, in the common
 * case, which puts them at the window's top-left) and everything else resolves normally. Reported, not
 * swallowed: a silent fallback here would hide exactly the class of defect that produced that bug, so
 * the ids are named -- with each unresolvable target beside them, since "anchored to something that is
 * not being drawn" and "anchored in a circle" are different defects and the message says which.
 * Warn-once by message, because this runs every frame.
 */
export function resolveAnchors(nodes: LayoutNode[], viewport: Viewport): Map<string, Rect> {
  const units = viewportUnits(viewport);
  const screen: Rect = { left: 0, top: 0, width: units.width, height: units.height };

  const resolved = new Map<string, Rect>();
  const known = new Set(nodes.map((node) => node.id));
  let pending = nodes.slice();

  while (pending.length > 0) {
    const ready = pending.filter((node) =>
      node.anchors.every((anchor) => !anchor.relativeTo || resolved.has(anchor.relativeTo)),
    );

    if (ready.length === 0) {
      reportUnresolvable(pending, known);
      for (const node of pending) {
        // The node's resolvable anchors only. Dropping the others is what breaks the deadlock; keeping
        // the rest means a node held by one good anchor and one bad one still lands near where it
        // belongs instead of in the corner.
        const usable = node.anchors.filter(
          (anchor) => !anchor.relativeTo || resolved.has(anchor.relativeTo),
        );
        resolved.set(node.id, resolveOne({ ...node, anchors: usable }, resolved, screen));
      }
      return resolved;
    }

    for (const node of ready) {
      resolved.set(node.id, resolveOne(node, resolved, screen));
    }

    pending = pending.filter((node) => !resolved.has(node.id));
  }

  return resolved;
}

/** The one console line for a deadlocked set: which node, which target, and which of the two faults. */
function reportUnresolvable(pending: LayoutNode[], known: Set<string>): void {
  const details = pending.flatMap((node) =>
    node.anchors
      .filter((anchor) => anchor.relativeTo !== undefined)
      .map((anchor) => ({ node: node.id, target: anchor.relativeTo as string })),
  );
  const missing = details.filter((detail) => !known.has(detail.target));
  const parts = (missing.length > 0 ? missing : details).map(
    (detail) => `${detail.node} -> ${detail.target}`,
  );
  const kind =
    missing.length > 0
      ? 'anchored to a widget that is not in the draw list (hidden, or destroyed)'
      : 'anchor cycle';
  const message =
    `layout: ${pending.length} widget(s) could not be placed -- ${kind}: ${parts.join(', ')}. ` +
    'They are placed by their remaining anchors; the rest of the screen still draws.';
  if (warned.has(message)) {
    return;
  }
  warned.add(message);
  console.warn(message);
}
