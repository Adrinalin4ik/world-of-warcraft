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
  /** `clampedToScreen="true"` -- see `clampToScreen` and `Widget#clampedToScreen`. */
  clamped?: boolean;
  /**
   * The node's EFFECTIVE scale: its own `SetScale` multiplied by every ancestor's. Absent means 1.
   *
   * Supplied by the caller rather than derived here, because the caller already walks the tree
   * top-down and can carry the product for free -- see `WidgetRoot#drawList`.
   *
   * It multiplies THREE things and the choice of which is the whole content of scale support:
   * the node's own width and height, and its anchor OFFSETS. The offsets scale because a
   * `SetPoint(..., x, y)` is expressed in the anchored frame's own coordinate space, which is what
   * `WorldMapButton_OnUpdate` relies on -- it computes `playerX * WorldMapDetailFrame:GetWidth()`
   * and hands the result straight back as an offset, so a `GetWidth` in own-space units and an
   * offset in own-space units are the same number twice and cancel correctly at any scale.
   *
   * It does NOT multiply a size that two opposing anchors already determined: that width is the
   * distance between two resolved points and is scaled by whatever scaled them.
   */
  scale?: number;
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

/**
 * Do these anchors constrain BOTH horizontal edges?
 *
 * The same question `resolveOne` below answers when it SIZES an axis from its anchors
 * (`width = right - left`), asked separately because the widget layer needs it for a different
 * purpose: a FontString whose left AND right edges are both pinned has been given a width budget by
 * the document even though its `<Size>` says `x="0"` -- which is exactly how the options panels
 * author their description paragraphs (`interfaceoptionspanels.xml:64-79`: `<Size y="32" x="0"/>`,
 * `TOPLEFT` to the title and `RIGHT` at -32 from the panel edge). See `widget.ts#effectiveFont`.
 *
 * Edge points only, and for the same reason `resolveOne` gives: `TOP`/`CENTER`/`BOTTOM` pin the
 * horizontal CENTRE, which places a node without bounding it.
 */
export function boundsBothHorizontalEdges(anchors: Anchor[]): boolean {
  let left = false;
  let right = false;
  for (const anchor of anchors) {
    const h = HORIZONTAL[anchor.point];
    if (h === 0) {
      left = true;
    } else if (h === 1) {
      right = true;
    }
  }
  return left && right;
}

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
  const scale = node.scale ?? 1;
  // The AUTHORED size at this node's effective scale. Used only on an axis the anchors did not
  // already size -- see `LayoutNode#scale`.
  const scaledWidth = node.width * scale;
  const scaledHeight = node.height * scale;
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
    // FrameXML's `+y` is up; our `top` grows downward, hence the subtraction. Scaled because an
    // offset is in the anchored frame's OWN space -- see `LayoutNode#scale`.
    const x = target.x + anchor.x * scale;
    const y = target.y - anchor.y * scale;

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
    left = centerX - scaledWidth / 2;
  }
  if (top === null && bottom === null && centerY !== null) {
    top = centerY - scaledHeight / 2;
  }

  const width = left !== null && right !== null ? right - left : scaledWidth;
  const height = top !== null && bottom !== null ? bottom - top : scaledHeight;

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
 * control there. MEASURED on `/game?offline=1&ui=lua`: 41 drawn widgets had no anchors at all, 15 of
 * them frames of that shape; the other 26 were regions, and those are the loader's business
 * (`framexml/loader.ts#applyRegionLayout`), not this function's.
 *
 * COST: a fixpoint over the node list, so worst case O(nodes x anchors x depth). At the 306 nodes the
 * world tree draws it is not measurable -- `ui.layout` p50 was 0.4 ms before and 0.5 ms after, inside
 * run-to-run spread. It would need rethinking if the node set ever became the whole 4225-frame tree
 * rather than the visible part of it.
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

/**
 * `clampedToScreen`: SHIFT a rect back inside the window, never resize it.
 *
 * The client's own attribute, declared on the frames that need it -- `GameTooltipTemplate`
 * (`gametooltiptemplate.xml:3`), the three `ShoppingTooltip`s (`gametooltip.xml:6-8`),
 * `ConsolidatedBuffsTooltip` (`buffframe.xml:141`) -- and issued by the loader since it was written
 * (`framexml/loader.ts:731` calls `SetClampedToScreen(true)`). Nothing implemented the method, so a
 * tooltip anchored to a button near the bottom of the screen resolved half off it and the body was cut
 * off: the owner's first screenshot. This is the engine honouring a declaration, not a clamp invented in
 * TypeScript -- the frame's own XML asks for exactly this.
 *
 * A frame WIDER or TALLER than the window keeps its top-left corner on screen and overflows the far edge,
 * because `Math.min` is applied after `Math.max`: there is no position that satisfies both and the
 * near edge is the one a reader starts at.
 */
function clampToScreen(rect: Rect, screen: Rect): Rect {
  return {
    ...rect,
    left: Math.max(0, Math.min(rect.left, screen.width - rect.width)),
    top: Math.max(0, Math.min(rect.top, screen.height - rect.height)),
  };
}

/**
 * `resolveOne` plus the frame's own `clampedToScreen`. One function so both of `resolveAnchors`' paths --
 * the ordinary one and the deadlock fallback -- clamp identically, and so a DEPENDENT of a clamped frame
 * sees the clamped rect: the resolver stores what this returns and everything anchored to it reads that.
 */
function place(node: LayoutNode, resolved: Map<string, Rect>, screen: Rect): Rect {
  const rect = resolveOne(node, resolved, screen);
  return node.clamped ? clampToScreen(rect, screen) : rect;
}

/**
 * Widget id -> the frame NAME the client knows it by, for the complaint below.
 *
 * **The warning used to print raw ids and that made it useless to act on.** The owner pasted
 * "lua:17608 -> lua:17596, lua:4241 -> lua:4242" and neither of us could say what had moved: the id
 * is `FrameRegistry`'s counter and means nothing outside it. A warning nobody can act on is a
 * warning that gets scrolled past, which is the same failure as no warning at all.
 *
 * A published resolver rather than an import, for the reason `ui/rects.ts` publishes its own: this
 * module is the widget layer and knows nothing about Lua or the registry, and it must keep working
 * with no resolver at all -- every unit test of the solver runs without one.
 */
let nameOfWidget: ((id: string) => string | null) | null = null;

/** The object model publishes its registry lookup. Called once per runtime; cleared on teardown. */
export function setWidgetNameResolver(resolve: ((id: string) => string | null) | null): void {
  nameOfWidget = resolve;
}

/** `Name (lua:17608)`, or the bare id when nothing can name it. */
function describe(id: string): string {
  const name = nameOfWidget === null ? null : nameOfWidget(id);
  return name === null ? id : `${name} (${id})`;
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

  /**
   * A WORKLIST, NOT A ROUND-BASED FILTER -- and this was 36 ms of a 43 ms frame.
   *
   * The previous shape was `while (pending.length) { pending.filter(everyAnchorResolved) ... }`, which
   * re-scans every unresolved node on every round. That is O(nodes x chain depth), and the chain depth in
   * the client's own manifest is deep: a panel anchored to a panel anchored to a header, and so on.
   *
   * **The tell was that the SAME solver cost 0.4 ms in one caller and 36 ms in the other.**
   * `WidgetRoot#drawList` feeds it only the widgets it is going to draw -- a few hundred -- while
   * `layoutRects` feeds it all 4211, hidden panels included. In a quadratic solver a 10x input is a 100x
   * cost, which is exactly the ratio the owner's HUD showed between `ui.layout` and `ui.scroll`.
   *
   * Why `layoutRects` runs at all on an ordinary frame: `rects.ts#layoutRectOf` re-resolves whenever
   * `layoutRevision()` has moved, `reconcileScrollRanges` calls it once per frame for the one on-screen
   * scroll frame, and the census measured geometry moving **1.22 times per frame** -- one `SetPoint` from
   * an `OnUpdate` handler is enough, and one is all it takes.
   *
   * The transformation is a plain topological sort and the OUTPUT IS IDENTICAL: `place` reads only
   * already-resolved nodes, so any order that respects the dependencies gives the same rects. What is
   * preserved deliberately:
   *
   *  - An anchor to an id that is NOT in this node set can never be satisfied, exactly as before -- the
   *    old `resolved.has` test could never pass for it. Such nodes fall through to the deadlock branch.
   *  - A CYCLE leaves its members unresolved and reaches the same `reportUnresolvable` and the same
   *    place-by-remaining-anchors recovery.
   */
  const waitingOn = new Map<string, number>();
  const dependents = new Map<string, LayoutNode[]>();
  const ready: LayoutNode[] = [];

  for (const node of nodes) {
    let count = 0;
    for (const anchor of node.anchors) {
      const target = anchor.relativeTo;
      if (target === undefined) {
        continue;
      }
      if (!known.has(target)) {
        // Unsatisfiable for ever, as before: leave it counted so this node never becomes ready.
        count += 1;
        continue;
      }
      count += 1;
      const list = dependents.get(target);
      if (list === undefined) {
        dependents.set(target, [node]);
      } else {
        list.push(node);
      }
    }
    waitingOn.set(node.id, count);
    if (count === 0) {
      ready.push(node);
    }
  }

  while (ready.length > 0) {
    const node = ready.pop()!;
    resolved.set(node.id, place(node, resolved, screen));
    const waiters = dependents.get(node.id);
    if (waiters === undefined) {
      continue;
    }
    for (const waiter of waiters) {
      const left = (waitingOn.get(waiter.id) ?? 0) - 1;
      waitingOn.set(waiter.id, left);
      if (left === 0) {
        ready.push(waiter);
      }
    }
  }

  const stuck = nodes.filter((node) => !resolved.has(node.id));
  if (stuck.length > 0) {
    reportUnresolvable(stuck, known);
    for (const node of stuck) {
      // The node's resolvable anchors only. Dropping the others is what breaks the deadlock; keeping
      // the rest means a node held by one good anchor and one bad one still lands near where it
      // belongs instead of in the corner.
      const usable = node.anchors.filter(
        (anchor) => !anchor.relativeTo || resolved.has(anchor.relativeTo),
      );
      resolved.set(node.id, place({ ...node, anchors: usable }, resolved, screen));
    }
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
    (detail) => `${describe(detail.node)} -> ${describe(detail.target)}`,
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
