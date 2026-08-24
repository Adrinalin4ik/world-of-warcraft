/**
 * FRAME and MODEL: the methods a plain frame answers to that a bare Region/LayeredRegion does not --
 * frame strata and level, mouse input, backdrops, and the two child-region constructors -- plus the
 * model-frame stubs.
 *
 * `SetScript`/`GetScript` and `RegisterEvent`/`UnregisterEvent` are in the plan's Frame list but are
 * deliberately NOT here: `object.ts`'s own docstring assigns `SetScript` to Task 5, and the plan
 * gives `RegisterEvent`/`UnregisterEvent` their own task (Task 6, `lua/events.ts`) with real ordering
 * rules ("re-registering keeps the original position", "dispatch re-reads the live list") that a
 * stub here would either fake or collide with. Registering a placeholder now that Task 5/6 overwrite
 * is harmless (`registerMethods` merges), but a placeholder that does nothing observable is also not
 * worth the confusion of two tasks touching the same name for different reasons.
 */
import { MethodTable, onFrameTeardown, registerMethods } from '../object';
import { questBlobs } from '../../../quest-blobs';
import { invokeScriptHandler, reportScriptError } from '../scripts';
import { NO_TINT } from '../../../backdrop';
import type { BackdropTint, Insets } from '../../../backdrop';
import { Layer, Widget } from '../../../widget';
import { screenScale } from '../../../layout';
import { STRATA_ORDER, Strata } from '../../order';
import { isDrawLayer, notImplemented, warnOnce, widgetOf } from './region';

/**
 * `Frame:GetID()`/`SetID()` -- an arbitrary numeric tag (list-row index, action-button slot, ...),
 * unrelated to the widget's own string `id` that `layout.ts` anchors against. Kept in a side table
 * rather than on `Widget` itself: it is a pure Lua-surface concept with no rendering or layout
 * meaning, unlike everything else `Widget` carries.
 */
const frameIds = new Map<number, number>();

/**
 * `SetAttribute`/`GetAttribute` storage, per frame, keyed by LOWER-CASED attribute name.
 *
 * A side table for the same reason `frameIds` is one: an attribute is a pure Lua-surface concept with
 * no rendering or layout meaning, so it does not belong on `Widget`.
 */
const frameAttributes = new Map<number, Map<string, unknown>>();

/**
 * The `(r, g, b [, a])` argument list the two backdrop-colour setters share. Non-numeric arguments
 * fall back to the untinted channel rather than to `NaN`, which would blank the piece entirely.
 */
function tintOf(args: unknown[]): BackdropTint {
  const channel = (value: unknown): number => (typeof value === 'number' ? value : 1);
  return { r: channel(args[0]), g: channel(args[1]), b: channel(args[2]), a: channel(args[3]) };
}

/**
 * A released frame takes its numeric tag with it -- see `object.ts`'s `FRAME_TEARDOWN`.
 *
 * Its attribute handles go too, and they must be UNREF'd rather than merely dropped: `SetAttribute`
 * retains a handle for every table or function value (see it for why), and a `Map.delete` releases the JS
 * reference while leaving the Lua registry slot pinned for the life of the VM.
 */
onFrameTeardown((ctx, id) => {
  frameIds.delete(id);
  const attributes = frameAttributes.get(id);
  if (attributes !== undefined) {
    for (const value of attributes.values()) {
      if (ctx.vm.isRef(value)) {
        ctx.vm.unref(value);
      }
    }
  }
  frameAttributes.delete(id);
});

/**
 * THE TREE WALK -- `GetChildren` / `GetNumChildren` / `GetRegions` / `GetNumRegions`.
 *
 * **NONE OF THESE EXISTED ON ANY CLASS**, which self-review caught while checking a claim this round
 * had just written down. The last round reported that `WorldFrame:GetChildren()` raises "because there
 * is no `WorldFrame` type"; that was HALF the cause. Adding the type made the global real and the call
 * still answered nothing, because `GetChildren` was absent everywhere. Both halves are closed here.
 *
 * They matter beyond one frame: walking `WorldFrame:GetChildren()` every tick is how every nameplate
 * addon of this era finds plates, and `GetRegions()` is how it then finds the health bar and the name.
 * The four are pure reads of the tree the widget layer already holds -- no state of their own, nothing
 * cached, nothing to keep in step.
 *
 * **CHILDREN AND REGIONS ARE THE SAME LIST, SPLIT BY KIND**, which is the client's own division: a
 * `<Texture>` or `<FontString>` is a REGION and everything else is a child FRAME. `Widget.kind` carries
 * exactly that, so the split is read off the widget rather than tracked separately -- one list cannot
 * drift from the other if there is only one list.
 *
 * Returned as a VARARG, not a table: the real API is `local a, b, c = f:GetChildren()` and
 * `select("#", f:GetChildren())`, and `frame_alpha.lua`-style callers index the varargs directly. A
 * table would break every one of them.
 */
const isRegionKind = (kind: string): boolean => kind === 'texture' || kind === 'fontstring';

const FRAME: MethodTable = {
  GetChildren: (ctx, self) => ctx.registry
    .childrenOf(self)
    .filter((id) => {
      const widget = ctx.registry.widget(id);
      return widget !== null && widget !== undefined && !isRegionKind(widget.kind);
    })
    .map((id) => ctx.wrapper(id)),

  GetNumChildren: (ctx, self) => [ctx.registry.childrenOf(self).filter((id) => {
    const widget = ctx.registry.widget(id);
    return widget !== null && widget !== undefined && !isRegionKind(widget.kind);
  }).length],

  GetRegions: (ctx, self) => ctx.registry
    .childrenOf(self)
    .filter((id) => {
      const widget = ctx.registry.widget(id);
      return widget !== null && widget !== undefined && isRegionKind(widget.kind);
    })
    .map((id) => ctx.wrapper(id)),

  GetNumRegions: (ctx, self) => [ctx.registry.childrenOf(self).filter((id) => {
    const widget = ctx.registry.widget(id);
    return widget !== null && widget !== undefined && isRegionKind(widget.kind);
  }).length],

  GetID: (_ctx, self) => [frameIds.get(self) ?? 0],
  SetID: (_ctx, self, args) => {
    frameIds.set(self, Number(args[0] ?? 0));
    return [];
  },

  SetFrameStrata: (ctx, self, args) => {
    const value = String(args[0] ?? '').toUpperCase();
    if (!STRATA_ORDER.includes(value as Strata)) {
      warnOnce(`SetFrameStrata: unknown strata '${value}'`);
      return [];
    }
    const widget = widgetOf(ctx, self);
    // Same-value guard for the same reason `SetFrameLevel` below has one: `restamp()` moves a frame
    // to its bucket's tail, and a no-op set re-stamping it would jump it to the front of its strata
    // for no reason.
    if (widget.strata === value) {
      return [];
    }
    widget.strata = value as Strata;
    widget.restamp();
    return [];
  },
  GetFrameStrata: (ctx, self) => [widgetOf(ctx, self).strata],

  // THE rule this file exists to get right: a same-value `SetFrameLevel` must early-out before
  // touching `restamp()`. Re-stamping on a no-op set is what makes a frame jump to the front of its
  // draw bucket for no reason -- nothing about "set my level to what it already is" should move
  // anything.
  SetFrameLevel: (ctx, self, args) => {
    shiftLevel(widgetOf(ctx, self), Number(args[0] ?? 0));
    return [];
  },
  GetFrameLevel: (ctx, self) => [widgetOf(ctx, self).frameLevel],

  // Real `Region` has NO scale method at all in the 3.3.5 API -- scale is Frame-only, because it
  // cascades to a frame's CHILDREN, and a leaf Texture/FontString has none to cascade to. Registering
  // these on REGION (as an earlier pass here did) would make `if texture.SetScale then` true, which
  // is exactly the duck-typing leak this task exists to close.
  /**
   * `SetScale(s)` -- REAL now, and the note above it used to say `widget.ts` had no field for it.
   *
   * The gap was visible on the world map: the player marker landed at 0.81/0.80 of the map where the
   * arithmetic gives 0.48/0.45, a ratio of about 1.7 -- which is `1 / WORLDMAP_WINDOWED_SIZE`.
   * `WorldMapFrame_SetFullMapView` scales the detail frame and `WorldMap_ToggleSizeUp/Down` rescale
   * it, so with the call dropped the frame kept its authored size while every offset computed from
   * that size was meant for a scaled one.
   *
   * `Widget#setScale` touches geometry, because every rect in the subtree moves.
   */
  SetScale: (ctx, self, args) => {
    const widget = ctx.registry.widget(self);
    if (widget !== null) {
      widget.setScale(Number(args[0]));
    }
    return [];
  },
  // `SetClampRectInsets(left, right, top, bottom)` -- how far a clamped frame may go PAST the screen
  // edge. `SetClampedToScreen` below is real; this is the inset it clamps to, and `widget.ts` has no
  // field for it. MEASURED as the only remaining load error in `ChatFrame1`'s own OnLoad
  // (`floatingchatframe.xml:883`, relative line 13), which mattered because a raise there skips the
  // rest of that OnLoad.
  SetClampRectInsets: notImplemented('SetClampRectInsets',
    'widget.ts has no clamp-inset field; SetClampedToScreen clamps to the bare screen rect'),
  /**
   * `GetEffectiveScale()` -- the widget's own scale, times every ancestor's, times the VIRTUAL-SCREEN
   * scale.
   *
   * That third factor is the one worth explaining. The client uses this global for exactly one kind
   * of arithmetic -- converting a cursor position into a frame's own space:
   *
   *     local x, y = GetCursorPosition();
   *     x = x / self:GetEffectiveScale();          (`worldmapframe.lua:743-745`)
   *
   * and `api/screen.ts` feeds `GetCursorPosition` in DEVICE pixels while every rect this layer
   * resolves is in VIRTUAL units (`layout.ts#screenScale`). In the real client `UIParent`'s effective
   * scale is precisely that conversion, so including it here is the client's own meaning rather than
   * an extra factor -- and leaving it out would put the cursor in the wrong space on any window that
   * is not exactly 768 units tall, which is every window.
   *
   * `window.innerHeight` rather than a threaded viewport: this is a Lua getter with no frame context,
   * and it is the same value `WorldUiHost#render` passes to the layout each frame.
   */
  GetEffectiveScale: (ctx, self) => {
    const own = ctx.registry.widget(self)?.effectiveScale ?? 1;
    const virtual = typeof window === 'undefined' ? 1 : screenScale(window.innerHeight);
    return [own * virtual];
  },

  /**
   * MOVING A WINDOW, and the KEYBOARD -- four gaps that the owner's world-map log named directly:
   *
   *     warning: SetMovable is not in this runtime's object model; every XML use of it is ignored
   *              (first: WorldMapFrame.xml:WorldMapScreenAnchor)
   *     warning: EnableKeyboard is not in this runtime's object model (first: WorldMapFrame.xml)
   *
   * They are declared rather than implemented, and the reason is not the flags -- a boolean on the
   * widget is nothing. `StartMoving` needs the input router to keep feeding pointer movement to a frame
   * that has claimed the drag, and `ui/input.ts` has no such claim: it routes a press to the widget
   * under the cursor and stops there. `EnableKeyboard` needs the same for keys, which today go to the
   * binding table (`framexml/bindings.ts`) and to a focused EditBox and nowhere else.
   *
   * Named as one block so the load report says "movable windows" rather than four unrelated lines. The
   * visible consequence is exactly what the owner has already reported -- a window cannot be dragged --
   * and Escape reaching `TOGGLEGAMEMENU` instead of a keyboard-enabled frame's own `OnKeyDown`.
   */
  SetMovable: notImplemented('SetMovable',
    'ui/input.ts has no drag claim, so a frame that may move has nothing to move it'),
  IsMovable: notImplemented('IsMovable', 'as SetMovable', [false]),
  StartMoving: notImplemented('StartMoving',
    'ui/input.ts routes a press to the widget under the cursor and does not keep feeding movement to '
    + 'a frame that has claimed a drag'),
  StopMovingOrSizing: notImplemented('StopMovingOrSizing', 'as StartMoving'),
  SetResizable: notImplemented('SetResizable', 'as SetMovable -- the same missing drag claim'),
  IsResizable: notImplemented('IsResizable', 'as SetResizable', [false]),
  EnableKeyboard: notImplemented('EnableKeyboard',
    'key presses go to the binding table and to a focused EditBox; no frame receives OnKeyDown'),
  IsKeyboardEnabled: notImplemented('IsKeyboardEnabled', 'as EnableKeyboard', [false]),


  /**
   * `GetScale()` -- the frame's own scale, unmultiplied by its ancestors' (that is
   * `GetEffectiveScale`). It answered a hardcoded 1 while `SetScale` was a no-op; both are real now,
   * so the note that used to say "reading back the value nothing can change" no longer applies.
   *
   * **ITS ABSENCE WAS THE WHOLE OF "I don't see options in selects".** `ToggleDropDownMenu`'s third
   * statement is `local uiParentScale = UIParent:GetScale()` (`uidropdownmenu.lua:621`), and it runs
   * BEFORE the loop that adds the menu's buttons -- so every dropdown in the client opened to a list
   * frame carrying nothing but its own scroll arrows. Measured: `shownButtons=3`, the first of them
   * "Scroll Up", and the toggle raising on this method.
   */
  GetScale: (ctx, self) => [ctx.registry.widget(self)?.scale ?? 1],

  EnableMouse: (ctx, self, args) => {
    widgetOf(ctx, self).mouseEnabled = Boolean(args[0]);
    return [];
  },

  /**
   * `SetClampedToScreen(clamped)` / `IsClampedToScreen()` -- keep the frame inside the window.
   *
   * `loader.ts:731` has issued this for every `clampedToScreen="true"` element since it was written and
   * the method did not exist, so the attribute did nothing: a `GameTooltip` (which declares it,
   * `gametooltiptemplate.xml:3`) anchored to a button near the bottom of the screen resolved half off it
   * and its body was cut off. `layout.ts#clampToScreen` is the geometry; this is only the flag, and it is
   * `Boolean(args[0])` rather than Lua truthiness because both spellings the loader and FrameXML use are
   * real booleans here.
   */
  SetClampedToScreen: (ctx, self, args) => {
    widgetOf(ctx, self).clampedToScreen = Boolean(args[0]);
    return [];
  },
  IsClampedToScreen: (ctx, self) => [widgetOf(ctx, self).clampedToScreen],

  /**
   * `SetHitRectInsets(left, right, top, bottom)` -- shrink (positive) or grow (negative) the rect the
   * frame is CLICKABLE in, without moving the rect it DRAWS in.
   *
   * Real, not a stub, and the reason is that it is load-bearing on the very first frame of the
   * in-world UI: `TargetFrame_OnLoad` calls `self:SetHitRectInsets(20, 35, 10, 25)`
   * (`Interface\FrameXML\TargetFrame.xml`, `<OnLoad>`), and with the method missing that `OnLoad`
   * RAISES and takes the rest of the handler -- the unit-frame registration, the border art -- with
   * it. It was one of only two errors `TargetFrame.xml` produced in the FrameXML load survey.
   *
   * Stored on the widget rather than applied to `width`/`height`: the two rects are genuinely
   * different, and folding the insets into the layout rect would move the art. benilla keeps the same
   * split (`crates/benilla-ui/src/widget/mod.rs:236`, applied in `widget/propagation.rs:269`) and
   * exposes it both from XML (`loader/geometry.rs:46-61`) and from Lua
   * (`script/object/frame_state.rs:365`).
   *
   * NOTE the argument order: left, right, TOP, BOTTOM -- not the CSS order.
   */
  SetHitRectInsets: (ctx, self, args) => {
    const side = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    widgetOf(ctx, self).hitRectInsets = {
      left: side(args[0]),
      right: side(args[1]),
      top: side(args[2]),
      bottom: side(args[3]),
    };
    return [];
  },
  GetHitRectInsets: (ctx, self) => {
    const insets = widgetOf(ctx, self).hitRectInsets;
    return [insets.left, insets.right, insets.top, insets.bottom];
  },

  /**
   * `SetAttribute(name, value)` / `GetAttribute(name)` -- the per-frame attribute table.
   *
   * REAL STORAGE, and the split between what this does and what it does not is the whole point.
   *
   * An attribute is just a named value on a frame. What makes attributes SPECIAL in 3.3.5a is the
   * secure-handler system built on top of them: `SecureHandlers.lua` compiles restricted Lua snippets
   * stored in attributes like `_onclick`, and the engine runs those snippets in a sandbox during
   * combat when ordinary code is locked out. That second half is NOT here, and its absence is
   * declared at `lua/api/secure.ts` rather than faked. Nothing in this client is combat-locked,
   * because nothing here is protected in the first place.
   *
   * The storage half is what the manifest actually needs at LOAD time, and it is 87 of the load
   * errors in the survey's TargetFrame prefix -- the largest single cause. `UIDropDownMenu.lua:42`
   * calls `self:SetAttribute("UIDropDownMenu", true)` from `UIDropDownMenu_Initialize`, which
   * `TargetFrame_OnLoad` reaches through its right-click unit menu; without the method that `OnLoad`
   * raises and the target frame never finishes loading.
   *
   * `OnAttributeChanged(self, name, value)` fires on every set, INCLUDING one that writes the value
   * the attribute already had -- the engine does not dedup, and `UpdateUIPanelPositions` (which
   * `UIParent.xml` installs as an `OnAttributeChanged`) relies on being told.
   *
   * The name is LOWER-CASED on both set and get: the engine's attribute table is case-insensitive,
   * and FrameXML relies on it -- `SecureButton_GetModifiedAttribute` builds names by concatenating a
   * prefix, a button name and a suffix whose cases do not agree.
   *
   * ## A TABLE VALUE MUST BE RETAINED, and not doing so was why NO `UIPanel` COULD EVER OPEN
   *
   * A Lua table or function crossing this boundary arrives as a `LuaRef`, and **arguments are BORROWED**:
   * the call boundary releases every handle among them when the method returns
   * (`object.ts#MethodContext.retain`, and `releaseAll`). Storing `args[1]` raw therefore kept a handle to
   * a registry slot that was freed a moment later and then REUSED by the next value crossing the
   * boundary -- so the attribute silently became some unrelated Lua value, with no error anywhere. That is
   * verbatim the hazard `LuaVM#dup`'s own docstring warns about.
   *
   * MEASURED live, and it is what blocked the spellbook after its API existed. `ShowUIPanel`
   * (`uiparent.lua:1962-1975`) is a two-line dispatch:
   *
   *     FramePositionDelegate:SetAttribute("panel-frame", frame);
   *     FramePositionDelegate:SetAttribute("panel-show", true);
   *
   * and the handler reads the frame back out. With the value not retained, `panel-frame` read as nil and
   * the console said so:
   *
   *     8: OnAttributeChanged(panel-show): [string "UIParent.lua"]:55:
   *     attempt to index a nil value (local 'frame')
   *
   * -- `uiparent.lua:54-55` is `GetUIPanelWindowInfo(frame, name)` doing `UIPanelWindows[frame:GetName()]`.
   * So `ToggleSpellBook("spell")` ran clean, `ShowUIPanel` was reached, and the frame was never shown.
   * **This was never specific to the spellbook**: every `UIPanel` in the client goes through the same two
   * lines, so the character sheet, the quest log and the world map were all blocked on it too.
   *
   * `ctx.retain` gives this a handle it owns, and the previous value's handle is released on overwrite and
   * on teardown -- otherwise every `SetAttribute` of a table would pin a registry slot for the session,
   * and `SecureTemplates` writes attributes constantly.
   */
  SetAttribute: (ctx, self, args) => {
    const name = String(args[0] ?? '').toLowerCase();
    if (name === '') {
      return [];
    }
    let table = frameAttributes.get(self);
    if (table === undefined) {
      table = new Map();
      frameAttributes.set(self, table);
    }
    const raw = args[1] ?? null;
    // Retained BEFORE the old value is released, so `SetAttribute(n, frame:GetAttribute(n))` -- a write of
    // the value already there -- cannot free the only handle to it in between.
    const value = ctx.vm.isRef(raw) ? ctx.retain(raw) : raw;
    const previous = table.get(name);
    table.set(name, value);
    if (ctx.vm.isRef(previous) && previous !== value) {
      ctx.vm.unref(previous);
    }
    // Fired AFTER the write, so a handler that reads the attribute back sees the new value.
    //
    // AND ITS FAILURE IS REPORTED, which it was not. Discarding this return value hid a whole broken
    // subsystem for two rounds: `UIParent_ManageFramePositions()` is nothing but
    // `FramePositionDelegate:SetAttribute("uiparent-manage", true)` (`uiparent.lua:1949-1952`), so the
    // ENTIRE managed-frame-position pass runs inside this one dispatch. It was raising on its first
    // statement (a nil `GetScreenResolutions`, `uiparent.lua:1170`) and the error died here -- `vm.run`
    // returned null, `drainScriptErrors` had nothing, the load report was clean, and the observable
    // symptom was a cast bar 40 units low with a pass that "ran". `methods/region.ts`'s own
    // `cascadeVisibility` and `methods/statusbar.ts:114-117` already did this correctly; this was the outlier.
    const error = invokeScriptHandler(ctx, self, 'OnAttributeChanged', [name, value]);
    if (error !== null) {
      const frameName = ctx.registry.nameOf(self) ?? String(self);
      reportScriptError(`${frameName}: OnAttributeChanged(${name})`, error.message);
    }
    return [];
  },
  /**
   * `GetAttribute(name)` -- and `GetAttribute(prefix, name, suffix)`, WHICH IS A DIFFERENT LOOKUP.
   *
   * The three-argument form was missing, and that is exactly why clicking an action button did
   * nothing. `SecureActionButton_OnClick` decides what a click DOES with
   *
   *     local actionType = SecureButton_GetModifiedAttribute(self, "type", button);
   *
   * and that function's body is `frame:GetAttribute(prefix, name, suffix)`
   * (`SecureTemplates.lua:153-172`), with `prefix` the modifier prefix (`""`, `"shift-"`, ...) and
   * `suffix` the button number (`"1"` for LeftButton, `SecureButton_GetButtonSuffix:83-87`). Reading
   * `args[0]` alone made that a lookup for the attribute literally named `""`, so `actionType` was nil,
   * so `SECURE_ACTIONS.action` -- the ONE path that calls `UseAction` -- was never selected. MEASURED
   * before the fix: `BonusActionButton2:GetAttribute("type")` = `"action"` while
   * `SecureButton_GetModifiedAttribute(b, "type", "LeftButton")` = nil.
   *
   * The candidate order is the engine's documented one, and the client's own files show why it must
   * have both ends: `ActionButton_OnLoad:84` stores the plain name (`SetAttribute("type", "action")`),
   * which only the bare-`name` fallback can find, while `SecureUnitButton_OnLoad:555-556` stores
   * `"*type1"`/`"*type2"`, which only the wildcard-prefix form can. The two middle candidates are the
   * same pattern with the wildcard on the other side; that pair is from the documented API rather than
   * from a use in this manifest, and is stated as such.
   *
   * `ATTRIBUTE_NOOP` is the empty string (`SecureTemplates.lua:17`) and the CALLER folds it to nil, so
   * nothing is done about it here.
   */
  GetAttribute: (ctx, self, args) => {
    const table = frameAttributes.get(self);
    const read = (key: string): unknown => table?.get(key.toLowerCase());
    if (args.length >= 3) {
      const prefix = String(args[0] ?? '');
      const name = String(args[1] ?? '');
      const suffix = String(args[2] ?? '');
      for (const key of [
        `${prefix}${name}${suffix}`,
        `*${name}${suffix}`,
        `${prefix}${name}*`,
        `*${name}*`,
        name,
      ]) {
        const value = read(key);
        if (value !== undefined && value !== null) {
          return [value];
        }
      }
      return [];
    }
    const value = read(String(args[0] ?? ''));
    return value === undefined || value === null ? [] : [value];
  },

  /**
   * `RegisterForDrag("LeftButton", ...)` -- which buttons begin a drag on this frame.
   *
   * **NOW ACTED ON.** This used to store the set and warn that no drag gesture existed, which was true
   * and was why dragging an ability did nothing at all. `ui/input.ts` has the gesture now -- press, a
   * move past a threshold, then `OnDragStart`; release, then `OnDragStop` on the source and
   * `OnReceiveDrag` on whatever is under the cursor -- and this method is what marks a frame as a drag
   * SOURCE for it. An unregistered frame keeps its click and can never start a drag, which is the
   * engine's rule and is what stops every button on the screen becoming draggable.
   *
   * **The button STRINGS are discarded**, and only `widget.dragRegistered` is kept. They were stored in a
   * per-frame map until this change, on the stated grounds that "a later drag router would read it" -- that
   * router is now here and it reads the boolean, so the map was state nothing could ever read again. See
   * the limitation at the bottom of this comment for what honouring the strings would actually take; it is
   * not a matter of having kept them.
   *
   * Registered on FRAME rather than on BUTTON because any Frame can be a drag source in this API, not
   * only a Button; benilla puts it on the shared frame table for the same reason
   * (`crates/benilla-ui/src/script/object/events_regions.rs:68-82`), and replaces the whole set on
   * each call, with an empty argument list clearing it.
   *
   * **The buttons themselves are not honoured**, and that is a real limitation rather than a shortcut:
   * `ActionBarButtonTemplate` registers `("LeftButton", "RightButton")` and `SpellButtonTemplate` only
   * `("LeftButton")` (`spellbookframe.lua:291`), but `input.ts#onPointerDown` never inspects
   * `event.button` and every press reaches Lua as `"LeftButton"` -- the same constraint that makes
   * `RegisterForClicks` a declared gap in `kinds.ts`. So a RIGHT-button drag on a spell button, which the
   * real client refuses, is accepted here. Closing it means plumbing `event.button` through the router.
   */
  RegisterForDrag: (ctx, self, args) => {
    const buttons = args.filter((arg): arg is string => typeof arg === 'string' && arg !== '');
    const widget = ctx.registry.widget(self);
    if (widget !== null) {
      // The whole set is REPLACED, so an empty argument list clears the registration -- which is the
      // engine's behaviour and the only way FrameXML has to make a frame undraggable again.
      widget.dragRegistered = buttons.length > 0;
    }
    return [];
  },

  /**
   * SetBackdrop(table) -- the tiled background plus the eight-piece border, as
   * `frame:SetBackdrop{ bgFile=, edgeFile=, tile=, edgeSize=, tileSize=, insets={...} }`.
   *
   * This was a warn-once no-op on the grounds that `MethodContext` cannot reach a `GlueArt` table to
   * turn a path into a sprite key. That reasoning had a hole: nothing says a sprite key may not BE the
   * path. `BackdropDef` holds keys, and a caller that registers each path under itself
   * (`framexml/runtime.ts`, which walks the finished tree and registers what it finds) makes the two
   * the same string -- so no art handle is needed here at all, only honest storage. Without this, every
   * `<Backdrop>` in the client's own XML drew nothing: both login edit boxes lost their border, and the
   * loader's `<Backdrop>` pass, which builds the table correctly, had nowhere to put it.
   *
   * The frame moves to BACKGROUND, because that is where the engine draws a Backdrop: BENEATH every
   * layer of its own frame, including the frame's own BACKGROUND font strings. Our layer ladder is
   * flat, so sitting on BACKGROUND ahead of them in insertion order is how that is expressed -- the
   * same thing `screens/login.ts` does by hand for the transcribed boxes, and what keeps an edit box's
   * placeholder visible on top of its border instead of behind it.
   */
  SetBackdrop: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const table = args[0];
    if (table === undefined || table === null) {
      widget.backdrop = null;
      return [];
    }
    if (!ctx.vm.isRef(table)) {
      throw new Error('SetBackdrop: the backdrop must be a table or nil');
    }
    const str = (key: string): string | null => {
      const value = ctx.vm.getTableField(table, key);
      return typeof value === 'string' && value !== '' ? value : null;
    };
    const numberField = (key: string, fallback: number): number => {
      const value = ctx.vm.getTableField(table, key);
      return typeof value === 'number' ? value : fallback;
    };

    // `insets` is a nested table, so reading it mints a handle this call owns and has to give back.
    const insets: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
    const insetsField = ctx.vm.getTableField(table, 'insets');
    if (ctx.vm.isRef(insetsField)) {
      try {
        for (const side of ['left', 'right', 'top', 'bottom'] as const) {
          const value = ctx.vm.getTableField(insetsField, side);
          if (typeof value === 'number') {
            insets[side] = value;
          }
        }
      } finally {
        ctx.vm.unref(insetsField);
      }
    }

    widget.backdrop = {
      bgSprite: str('bgFile'),
      edgeSprite: str('edgeFile'),
      edgeSize: numberField('edgeSize', 0),
      tileSize: numberField('tileSize', 0),
      backgroundInsets: insets,
      // New art, no colour history: the engine's `SetBackdrop` resets both tints, so a frame given a
      // second backdrop does not keep the first one's `SetBackdropColor`.
      color: NO_TINT,
      borderColor: NO_TINT,
    };
    widget.layer = 'BACKGROUND';
    return [];
  },

  /**
   * `SetBackdropColor(r, g, b, a)` tints the BACKGROUND piece; `SetBackdropBorderColor` the eight
   * EDGE pieces. Alpha is optional and defaults to 1, which is the engine's own default and matters:
   * `AccountLogin_OnLoad` passes only three arguments for the edit boxes and four (the last `0.85`)
   * for the character panel.
   *
   * Both are no-ops on a frame with no backdrop, and silently -- the engine has nothing to tint
   * either, and every caller in this manifest declares its backdrop in XML first.
   */
  SetBackdropColor: (ctx, self, args) => {
    const backdrop = widgetOf(ctx, self).backdrop;
    if (backdrop) {
      backdrop.color = tintOf(args);
    }
    return [];
  },
  SetBackdropBorderColor: (ctx, self, args) => {
    const backdrop = widgetOf(ctx, self).backdrop;
    if (backdrop) {
      backdrop.borderColor = tintOf(args);
    }
    return [];
  },

  // `registry.create` is the sanctioned path for a region owned by a frame -- `object.ts`'s own
  // comment on `CREATE_FRAME_CLASSES` is explicit that a Texture is created through its OWNER, not
  // through `CreateFrame`, and `create()` itself (unlike the `CreateFrame` Lua function) never
  // checked that list.
  CreateTexture: (ctx, self, args) => {
    const name = typeof args[0] === 'string' ? args[0] : null;
    const id = ctx.registry.create('Texture', name, self);
    applyLayer(ctx.registry.widget(id)!, args[1]);
    return [ctx.wrapper(id)];
  },
  CreateFontString: (ctx, self, args) => {
    const name = typeof args[0] === 'string' ? args[0] : null;
    const id = ctx.registry.create('FontString', name, self);
    applyLayer(ctx.registry.widget(id)!, args[1]);
    return [ctx.wrapper(id)];
  },

  /**
   * `RaiseFrameLevel()` / `RaiseFrameLevelByTwo()` / `LowerFrameLevel()` -- relative level nudges.
   *
   * Real, and they are simply `SetFrameLevel` with arithmetic: the client offers them because the
   * idiom `frame:SetFrameLevel(frame:GetFrameLevel() + 1)` is everywhere and the round trip through
   * Lua is not free. `UIDropDownMenu.lua` and the unit-frame border code both use them, and they were
   * 41 of the FrameXML prefix's load errors between them.
   *
   * Each goes through the same `restamp()`-on-change rule `SetFrameLevel` above documents, so a nudge
   * that lands on the level the frame already had does not move it in its draw bucket. A nudge always
   * changes the value by design, so in practice the guard never fires -- it is there so that the two
   * paths cannot drift apart.
   */
  RaiseFrameLevel: (ctx, self) => nudgeLevel(ctx, self, 1),
  RaiseFrameLevelByTwo: (ctx, self) => nudgeLevel(ctx, self, 2),
  LowerFrameLevel: (ctx, self) => nudgeLevel(ctx, self, -1),

  // Our draw order has one live-list axis (`linkStamp`) rather than the client's separate "raised"
  // flag; moving to the tail of the bucket is the same visible effect `Raise()` has -- above every
  // sibling at the same strata and level that has not itself been raised or shown since.
  Raise: (ctx, self) => {
    widgetOf(ctx, self).restamp();
    return [];
  },
};

/** The shared body of `RaiseFrameLevel`/`RaiseFrameLevelByTwo`/`LowerFrameLevel`. */
function nudgeLevel(ctx: Parameters<MethodTable[string]>[0], self: number, delta: number): unknown[] {
  const widget = widgetOf(ctx, self);
  shiftLevel(widget, widget.frameLevel + delta);
  return [];
}

/**
 * Move a frame to `level` AND CARRY ITS WHOLE SUBTREE WITH IT, keeping every relative offset.
 *
 * **THIS IS WHY THE STAT DROPDOWNS WOULD NOT OPEN**, and it was measured live rather than reasoned
 * about. `PlayerStatFrameLeftDropDown_OnLoad`'s first statement is `RaiseFrameLevel(self)`
 * (`paperdollframe.lua:1518`), and the frame it raises is the CONTAINER whose child `$parentButton`
 * carries the only `<OnClick>` that opens the menu -- `ToggleDropDownMenu(nil, nil, self:GetParent())`
 * (`uidropdownmenutemplates.xml:312-326`). The container also declares `enableMouse="true"` in the
 * client's own XML (`paperdollframe.xml:726`), so it is hit-testable by the document's own choice.
 *
 * Raising ONLY the frame put the container at its arrow button's level with a fresher `linkStamp` (the
 * `restamp()` below), so the container sorted AFTER its own child and `hitTest`'s backwards walk
 * answered the container. MEASURED with the panel open and the pointer on the arrow:
 *
 *     pointerWidget = PlayerStatFrameLeftDropDown        <- the container, not its button
 *     after a real click: IsShown()=false, UIDROPDOWNMENU_OPEN_MENU=nil, numButtons=5
 *
 * -- the list was already POPULATED by `UIDropDownMenu_Initialize` on show, and `ToggleDropDownMenu`
 * had simply never run, through 2.6 s of sampling. That is the whole of "options appear but choosing
 * one does nothing": the menu never opened at all.
 *
 * The engine's levels are RELATIVE -- `Widget#add:478` already builds them that way, a child frame at
 * the parent's level + 1 and a region at the owner's level -- so moving a parent must move the
 * subtree, or the invariant that built the tree is broken by the first `SetFrameLevel`.
 *
 * Regions shift too: `add` gives them their owner's level exactly so that `frameLevel` outranking
 * `layer` in `compareOrder` keeps a frame's art with the frame. Leaving them behind would separate a
 * raised frame from its own textures.
 */
function shiftLevel(widget: Widget, level: number): void {
  const delta = level - widget.frameLevel;
  if (delta === 0) {
    // The same-value guard `SetFrameLevel` has always had: a no-op write must not `restamp`, or a
    // redundant call would reorder the frame within its bucket.
    return;
  }
  const walk = (node: Widget): void => {
    node.frameLevel += delta;
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(widget);
  // Only the frame ITSELF is restamped. `linkStamp` is the live-list order within a bucket and the
  // client re-tails the frame that moved, not its descendants -- and restamping children would
  // reverse their relative order against each other.
  widget.restamp();
}

function applyLayer(widget: { layer: Layer }, arg: unknown): void {
  if (typeof arg !== 'string') {
    return;
  }
  const layer = arg.toUpperCase();
  if (isDrawLayer(layer)) {
    widget.layer = layer;
  } else {
    warnOnce(`CreateTexture/CreateFontString: unknown layer '${layer}'`);
  }
}

// The MODEL surface -- `SetModel`, `SetCamera`, `SetSequence`, the fog four, `SetGlow`, `ResetLights`
// and the three `Add*Light`s -- used to be thirteen `notImplemented` entries here, under a note saying
// they needed per-widget model state and a bridge to `GlueSceneView`. Both exist now
// (`Widget#modelRig` and `screens/framexml-screen.ts`'s per-tick poll), so the whole table moved to
// `methods/model.ts` where it is real. `AdvanceTime` is the one that is still a gap and it went with
// them, so the class has one home.

/**
 * QUESTPOIFRAME -- `<QuestPOIFrame name="WorldMapBlobFrame">`'s own engine surface.
 *
 * These were on FRAME, which was a duck-typing leak I accepted in the comment at the time: it made
 * `if frame.DrawQuestBlob then` true for every frame in the client. `QUESTPOIFRAME` is a real class now
 * (`object.ts`), so they live where they belong -- and the class had to exist anyway, because without it
 * the loader dropped the element and `WorldMapBlobFrame` was nil.
 *
 * A blob is the shaded AREA a quest objective covers, drawn from the polygon the server sends with
 * `SMSG_QUEST_POI_QUERY_RESPONSE`. **That reply has a subscriber now**
 * (`network/game/object/quest-poi.ts`), so the polygon exists and `DrawQuestBlob` is real -- see
 * `ui/quest-blobs.ts` for why it rasterises into a canvas rather than building regions.
 *
 * The two TEXTURE setters stay gaps, and honestly: `ui/quest-blobs.ts` fills with a flat colour
 * rather than the client's tiling art, so accepting a texture name here would claim it was used.
 * `SetBorderScalar` is the border's width multiplier and is in the same position.
 */
const QUESTPOIFRAME: MethodTable = {
  DrawQuestBlob: (ctx, self, args) => {
    questBlobs.draw(
      ctx,
      Math.trunc(Number(args[0])) || 0,
      !(args[1] === undefined || args[1] === null || args[1] === false),
    );
    return [];
  },
  // `DrawBlob(blobIndex, show)` is the same drawing keyed by POI id rather than quest id. Nothing
  // in this client calls it -- checked against the served worldmapframe.lua -- so it stays a
  // declared gap rather than a guess at which key it means.
  DrawBlob: notImplemented('DrawBlob',
    'no FrameXML caller; DrawQuestBlob is the one the map uses'),
  SetFillTexture: notImplemented('SetFillTexture',
    'ui/quest-blobs.ts fills with a flat colour, so a texture name would be ignored'),
  SetBorderTexture: notImplemented('SetBorderTexture', 'as SetFillTexture'),
  SetFillAlpha: (ctx, self, args) => {
    questBlobs.setFillAlpha(Number(args[0]));
    return [];
  },
  SetBorderAlpha: (ctx, self, args) => {
    questBlobs.setBorderAlpha(Number(args[0]));
    return [];
  },
  /**
   * `GetNumTooltips` -- how many objective tooltips the BLOB has, and **0 is the real answer.**
   *
   * It was absent, and the owner caught the raise it caused:
   *
   *     framexml: poiWorldMapPOIFrame1_3: OnEnter: WorldMapFrame.lua:1893:
   *         attempt to call a nil value (method 'GetNumTooltips')
   *
   * -- so hovering a quest pin threw and the pin had no tooltip at all.
   *
   * **0 routes the client onto the path that WORKS**, and that is why it is right rather than a
   * placeholder. `WorldMapQuestPOI_SetTooltip` uses the POI tooltips only when their count EQUALS
   * the objective count, and falls back to `GetQuestLogLeaderBoard` otherwise
   * (`worldmapframe.lua:1893-1901`) -- which is real here and reads the descriptor. A nonzero count
   * would send it to `GetQuestPOILeaderBoard`, which is not.
   *
   * Safe against the Lua-truthiness trap: 0 IS truthy, but the guard is
   * `numPOITooltips == numObjectives`, and a quest with 0 objectives never enters the loop.
   */
  GetNumTooltips: () => [0],
  // Unreachable behind that 0 -- the client only calls it when the counts match -- and registered
  // for the reason the object model registers unreachable methods: an addon duck-types first.
  GetTooltipIndex: notImplemented('GetTooltipIndex',
    'GetNumTooltips answers 0, so the client reads objectives from the quest log instead'),
  SetBorderScalar: notImplemented('SetBorderScalar',
    'the border is drawn at a fixed 2px; see ui/quest-blobs.ts'),
};

/**
 * `CreatePlayerArrowFrame` stays on FRAME: `WorldMapFrame_OnLoad` calls it on the MAP frame, not on the
 * blob frame, so moving it with the blob methods would have put it on a class its caller never touches.
 */
Object.assign(FRAME, {
  CreatePlayerArrowFrame: notImplemented('CreatePlayerArrowFrame',
    'the widget layer draws axis-aligned quads only, so a rotating arrow overlay has nowhere to '
    + 'draw; see map-bridge.ts on the world map arrow'),
});

registerMethods('FRAME', FRAME);
registerMethods('QUESTPOIFRAME', QUESTPOIFRAME);
