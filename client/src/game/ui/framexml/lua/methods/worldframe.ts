/**
 * WORLDFRAME -- the frame the world is drawn behind, and the one an addon walks to find nameplates.
 *
 * `Interface\FrameXML\WorldFrame.xml` is entry 12 of `FrameXML.toc` and its root element is
 * `<WorldFrame name="WorldFrame" movable="true" resizable="true" setAllPoints="true">`. The type did
 * not exist in this runtime, so `CreateFrame` threw "unknown frame type" and rule 5 dropped the element
 * and its whole subtree -- see `object.ts#CLASS_PARENT.WORLDFRAME` for the full list of what went with
 * it. The class itself is registered there; this file exists for the ONE method the type adds.
 *
 * ## WHY THIS MATTERS BEYOND ONE GLOBAL: `WorldFrame:GetChildren()`
 *
 * Every nameplate addon in this era finds plates the same way -- it walks `WorldFrame:GetChildren()`
 * each tick and treats each new anonymous child as a plate.
 *
 * **THE LAST ROUND NAMED HALF THE CAUSE.** It reported that the call raises "because there is no
 * `WorldFrame` type". True, and adding the type is not enough: **`GetChildren` did not exist on ANY
 * class in this runtime**, nor did `GetNumChildren`, `GetRegions` or `GetNumRegions`. That was found by
 * probing the live VM after the type landed and getting an answer of nothing back. Both halves are
 * closed -- see `methods/frame.ts` for the four tree reads.
 *
 * **What it does NOT yet answer with is a plate.** This client's plates are world-pass sprites
 * (`world/nameplates.ts`), created and drawn entirely engine-side, and nothing puts a `Frame` in the
 * Lua tree for one. So `WorldFrame:GetChildren()` returns the manifest's own `ActionStatus` and nothing
 * else. That is a stated gap, not a silent success: the global exists and answers honestly, and what it
 * answers with is the truth about this client.
 *
 * ## THE TENSION THE LAST ROUND REPORTED IS AN ARTIFACT, AND HERE IS THE LINE
 *
 * The previous round recorded that making plates Lua-reachable "puts plate rects in the draw list and
 * gives back the 4-7.5 ms saving" -- i.e. that addon fidelity and the frame budget are inherently
 * opposed. **They are not.** In the real client a nameplate is BOTH a `WorldFrame` child AND
 * engine-drawn; those are not alternatives there. The opposition here comes from one assumption of
 * OURS, and it is a single statement:
 *
 *     `widget.ts#Widget.drawList`'s `walk` does `flat.push({ widget, ... })` for EVERY shown widget,
 *     unconditionally -- before anything asks whether it has a sprite, a text or any drawable content.
 *
 * `flat` becomes `items`, and `world-ui.ts#drawListSignature` mixes every item's
 * `rect.left/top/width/height`. So a frame that merely EXISTS in the tree and moves enters the
 * fingerprint, and a per-unit plate frame tracking a walking mob would dirty it every frame. That is
 * the whole mechanism of the reported cost, and it is our own encoding of "every frame in the Lua tree
 * is rasterized by the UI pass".
 *
 * The same function shows the way out, because it already keeps the two concerns in separate lists:
 * `nodes` is what `resolveAnchors` sizes and places, and `flat` is what gets drawn. A widget pushed to
 * `nodes` but NOT to `flat` has a fully resolved rect -- so `GetLeft`, `GetTop`, `GetWidth`,
 * `GetHeight`, `GetCenter` and `IsShown` all answer -- while never appearing in `items`, never entering
 * `drawListSignature`, and never being rasterized. One flag on `Widget`, read at that one `push`.
 *
 * **NOT DONE IN THIS ROUND, deliberately.** The flag is the easy half; the surface an addon actually
 * uses is the work -- a `Frame` per plate parented to `WorldFrame`, with the child `StatusBar` and
 * regions `GetRegions()` is expected to return, created and destroyed as units stream, and kept in step
 * with the sprite stack that does the drawing. Half of that is worse than none of it, because an addon
 * that finds a plate and then cannot read its health bar fails in a way that looks like the addon's
 * bug. The measurement that would settle it is stated so the next round can run it rather than argue
 * it: build one such frame, move its rect every frame, and check that `window.uiDrawStats.dirtyFrames`
 * and `items` are unchanged against the plates-down arm -- the same two-arm comparison the plates
 * themselves were measured with (14/180-181, `items` identical in every arm).
 */
import { MethodTable, registerMethods } from '../object';
import { notImplemented } from './region';

const WORLDFRAME: MethodTable = {
  /**
   * `WorldFrame:IgnoreDepth(flag)` -- `worldframe.lua:26-28`'s entire `WorldFrame_OnLoad` body, and the
   * only WorldFrame-specific method the manifest calls.
   *
   * It tells the engine whether the frame's 3-D content participates in the depth buffer. There is
   * nothing here for it to control: the world is a separate three.js scene with its own depth buffer and
   * the interface is composited over it, so the frame this method is called on has no 3-D content of its
   * own at all. Declared through `notImplemented` rather than written as a no-op precisely because the
   * two are indistinguishable from the outside and the load report is where that difference lives.
   */
  IgnoreDepth: notImplemented(
    'WorldFrame:IgnoreDepth',
    'the world is a separate three.js scene composited under the interface, so this frame carries no'
    + ' 3-D content whose depth handling could be changed',
  ),
};

registerMethods('WORLDFRAME', WORLDFRAME);
